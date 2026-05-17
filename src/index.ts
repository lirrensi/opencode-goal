import { promises as fs } from "fs"
import path from "path"
import { randomUUID } from "crypto"
import { tool, type Plugin } from "@opencode-ai/plugin"

type GoalStatus = "active" | "paused" | "completed" | "budget_limited" | "blocked" | "cleared"

type Goal = {
  id: string
  sessionID: string
  objective: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  tokenBudget?: number
  tokensUsed: number
  timeUsedMs: number
  activeSince?: number
  lastAssistantMessageID?: string
  lastContinuationMessageID?: string
  lastContinuationHadToolCalls?: boolean
  continuationQueuedAt?: number
  suppressNextIdleContinuation?: boolean
  budgetWrapupSent?: boolean
  accountedAssistantTokens?: Record<string, number>
  completionSummary?: string
  blockedReason?: string
}

type State = {
  version: 1
  goals: Record<string, Goal>
}

type ParsedCommand =
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "create"; objective: string; tokenBudget?: number }
  | { kind: "help"; reason?: string }

const EMPTY_STATE: State = { version: 1, goals: {} }
const CONTINUATION_DEBOUNCE_MS = 1500
const GOAL_COMMAND_TEMPLATE = `OpenCode goal command arguments:

$ARGUMENTS

The opencode-plugin-goal plugin will rewrite this command before it reaches the assistant. If the plugin did not rewrite this prompt, tell the user that the goal plugin command hook did not run.`

function now() {
  return Date.now()
}

function key(sessionID: string) {
  return sessionID
}

function textPart(text: string) {
  return { type: "text" as const, text, synthetic: true }
}

function parseBudget(value: string) {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([kKmM])?$/)
  if (!match) return undefined
  const base = Number(match[1])
  if (!Number.isFinite(base) || base <= 0) return undefined
  const suffix = match[2]?.toLowerCase()
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1
  return Math.floor(base * multiplier)
}

function tokenize(input: string) {
  const result: string[] = []
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(input))) result.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["'])/g, "$1"))
  return result
}

function parseCommand(argumentsText: string): ParsedCommand {
  const trimmed = argumentsText.trim()
  if (!trimmed) return { kind: "status" }

  const tokens = tokenize(trimmed)
  const first = tokens[0]?.toLowerCase()
  if (first === "status" || first === "show") return { kind: "status" }
  if (first === "pause") return { kind: "pause" }
  if (first === "resume") return { kind: "resume" }
  if (first === "clear") return { kind: "clear" }
  if (first === "help" || first === "--help" || first === "-h") return { kind: "help" }

  let tokenBudget: number | undefined
  const objectiveTokens: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === "--budget" || token === "-b") {
      const next = tokens[++i]
      if (!next) return { kind: "help", reason: "Missing value after --budget." }
      tokenBudget = parseBudget(next)
      if (!tokenBudget) return { kind: "help", reason: `Invalid budget: ${next}` }
      continue
    }
    if (token.startsWith("--budget=")) {
      const value = token.slice("--budget=".length)
      tokenBudget = parseBudget(value)
      if (!tokenBudget) return { kind: "help", reason: `Invalid budget: ${value}` }
      continue
    }
    objectiveTokens.push(token)
  }

  const objective = objectiveTokens.join(" ").trim()
  if (!objective) return { kind: "help", reason: "Missing goal objective." }
  return { kind: "create", objective, tokenBudget }
}

function statusLine(goal: Goal | undefined) {
  if (!goal || goal.status === "cleared") return "No active goal. Use `/goal <objective>` to create one."
  const budget = goal.tokenBudget ? ` / ${goal.tokenBudget}` : ""
  const summary = goal.completionSummary ? `\nSummary: ${goal.completionSummary}` : ""
  const blocked = goal.blockedReason ? `\nBlocked: ${goal.blockedReason}` : ""
  return [
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Tokens used: ${goal.tokensUsed}${budget}`,
    `Time used: ${Math.round(goal.timeUsedMs / 1000)}s`,
    `Commands: /goal pause, /goal resume, /goal clear`,
    summary,
    blocked,
  ]
    .filter(Boolean)
    .join("\n")
}

function helpText(reason?: string) {
  return [
    reason ? `${reason}\n` : "",
    "Usage:",
    "- /goal <objective>",
    "- /goal --budget 100000 <objective>",
    "- /goal status",
    "- /goal pause",
    "- /goal resume",
    "- /goal clear",
  ]
    .filter(Boolean)
    .join("\n")
}

function createGoalPrompt(goal: Goal) {
  return `A persistent OpenCode goal has been created.\n\n${statusLine(goal)}\n\nStart working toward this goal now. Continue using tools and verification until the goal is actually complete or blocked. If it becomes complete or blocked, call update_goal with verified evidence. Do not ask the user to type continue when a clear next action remains.`
}

function managementPrompt(message: string, goal?: Goal) {
  return `${message}\n\n${statusLine(goal)}\n\nRespond with a concise acknowledgement only. Do not start new substantive work for this management command.`
}

function continuationPrompt(goal: Goal, budgetLimited: boolean) {
  if (budgetLimited) {
    return `The active goal has reached its token budget.\n\n${statusLine(goal)}\n\nWrap up gracefully. Summarize what was completed, what remains, and the concrete next action. Do not start new substantive work. Do not mark the goal complete unless it was already actually verified complete.`
  }

  return `Continue working toward the active OpenCode goal.\n\n${statusLine(goal)}\n\nBefore stopping, audit whether the objective is complete, blocked, or still has a clear next action. If complete, call update_goal with status "completed" and evidence. If blocked, call update_goal with status "blocked" and the blocker. If a clear next action remains, continue working instead of asking the user to type continue.`
}

async function ensureDir(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
}

export const GoalPlugin: Plugin = async ({ client, worktree, directory }) => {
  const root = directory || worktree
  const stateFile = path.join(root, ".opencode", "goals", "state.json")
  let stateQueue = Promise.resolve()
  const continuationInFlight = new Set<string>()
  const continuationPending = new Map<string, number>()

  async function readState(): Promise<State> {
    try {
      const raw = await fs.readFile(stateFile, "utf8")
      const parsed = JSON.parse(raw) as State
      if (!parsed || parsed.version !== 1 || !parsed.goals) {
        console.warn(`[goal-plugin] State file has unexpected format, resetting`)
        return { ...EMPTY_STATE }
      }
      return parsed
    } catch (error: any) {
      if (error?.code === "ENOENT") return { ...EMPTY_STATE }
      if (error instanceof SyntaxError) {
        console.error(`[goal-plugin] Corrupted state file: ${error.message}`)
        return { ...EMPTY_STATE }
      }
      console.error(`[goal-plugin] Error reading state:`, error)
      throw error
    }
  }

  async function writeState(state: State) {
    const hasLiveGoals = Object.values(state.goals).some((g) => g.status !== "cleared")
    if (!hasLiveGoals) {
      try { await fs.unlink(stateFile) } catch { /* already gone — that's fine */ }
      return
    }
    await ensureDir(stateFile)
    const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8")
    await fs.rename(tmp, stateFile)
  }

  async function updateState<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    const run = stateQueue.then(async () => {
      const state = await readState()
      const result = await fn(state)
      await writeState(state)
      return result
    })
    stateQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function getGoal(sessionID: string) {
    const state = await readState()
    return state.goals[key(sessionID)]
  }

  async function showToast(message: string, variant: "info" | "success" | "warning" | "error" = "info") {
    try {
      await (client as any).tui?.showToast?.({ body: { title: "Goal", message, variant, duration: 4000 } })
    } catch {
      // Toasts are best-effort; the prompt acknowledgement remains authoritative.
    }
  }

  async function queueContinuation(sessionID: string) {
    if (continuationInFlight.has(sessionID)) return
    const previous = continuationPending.get(sessionID) ?? 0
    const current = now()
    if (current - previous < CONTINUATION_DEBOUNCE_MS) return
    continuationPending.set(sessionID, current)

    const goal = await getGoal(sessionID)
    if (!goal || goal.status !== "active") {
      continuationPending.delete(sessionID)
      return
    }
    if (goal.suppressNextIdleContinuation) {
      await updateState((state) => {
        const stored = state.goals[key(sessionID)]
        if (stored) stored.suppressNextIdleContinuation = false
      })
      return
    }
    if (goal.lastContinuationMessageID && goal.lastContinuationHadToolCalls === false) return

    const budgetLimited = typeof goal.tokenBudget === "number" && goal.tokensUsed >= goal.tokenBudget
    if (budgetLimited && goal.budgetWrapupSent) return

    const next = await updateState((state) => {
      const stored = state.goals[key(sessionID)]
      if (!stored || stored.status !== "active") return undefined
      if (budgetLimited) {
        stored.status = "budget_limited"
        stored.budgetWrapupSent = true
      }
      stored.continuationQueuedAt = now()
      stored.lastContinuationMessageID = undefined
      stored.lastContinuationHadToolCalls = undefined
      stored.updatedAt = now()
      return { ...stored }
    })
    if (!next) return

    continuationInFlight.add(sessionID)
    try {
      await (client as any).session.promptAsync({
        path: { id: sessionID },
        body: { parts: [textPart(continuationPrompt(next, budgetLimited))] },
      })
    } finally {
      setTimeout(() => continuationInFlight.delete(sessionID), CONTINUATION_DEBOUNCE_MS)
    }
  }

  return {
    async config(config) {
      config.command ??= {}
      config.command.goal ??= {
        template: GOAL_COMMAND_TEMPLATE,
        description: "persistent goal workflow: create, status, pause, resume, clear",
      }
    },

    tool: {
      get_goal: tool({
        description: "Get the persistent goal for the current OpenCode session, if one exists.",
        args: {},
        async execute(_args, context) {
          const goal = await getGoal(context.sessionID)
          return goal ? statusLine(goal) : "No goal exists for this session."
        },
      }),
      update_goal: tool({
        description:
          "Update the current persistent goal when it is verified complete or blocked. Use only for completion/blockage, not pause/resume/clear.",
        args: {
          status: tool.schema.enum(["completed", "blocked"]),
          summary: tool.schema.string().describe("Evidence-backed completion summary or blocker description."),
        },
        async execute(args, context) {
          const updated = await updateState((state) => {
            const goal = state.goals[key(context.sessionID)]
            if (!goal || goal.status === "cleared") return undefined
            goal.status = args.status
            goal.updatedAt = now()
            goal.activeSince = undefined
            if (args.status === "completed") goal.completionSummary = args.summary
            if (args.status === "blocked") goal.blockedReason = args.summary
            return { ...goal }
          })
          if (!updated) return "No goal exists for this session."
          continuationPending.delete(context.sessionID)
          continuationInFlight.delete(context.sessionID)
          return `Goal marked ${updated.status}.\n${statusLine(updated)}`
        },
      }),
    },

    async "command.execute.before"(input, output) {
      if (input.command !== "goal") return

      const parsed = parseCommand(input.arguments)
      const sessionID = input.sessionID
      let prompt = ""

      if (parsed.kind === "help") {
        prompt = managementPrompt(helpText(parsed.reason), await getGoal(sessionID))
        await showToast("Goal help", "info")
      }

      if (parsed.kind === "status") {
        const goal = await getGoal(sessionID)
        prompt = managementPrompt("Goal status:", goal)
        await showToast(goal ? `Goal is ${goal.status}` : "No active goal", "info")
      }

      if (parsed.kind === "pause") {
        const goal = await updateState((state) => {
          const stored = state.goals[key(sessionID)]
          if (!stored || stored.status !== "active") return stored ? { ...stored } : undefined
          stored.status = "paused"
          stored.updatedAt = now()
          stored.activeSince = undefined
          return { ...stored }
        })
        prompt = managementPrompt(goal ? "Goal paused." : "No active goal to pause.", goal)
        await showToast(goal ? "Goal paused" : "No active goal", goal ? "warning" : "info")
      }

      if (parsed.kind === "resume") {
        const goal = await updateState((state) => {
          const stored = state.goals[key(sessionID)]
          if (!stored || !["paused", "blocked"].includes(stored.status)) return stored ? { ...stored } : undefined
          stored.status = "active"
          stored.updatedAt = now()
          stored.activeSince = now()
          stored.lastContinuationMessageID = undefined
          stored.lastContinuationHadToolCalls = undefined
          return { ...stored }
        })
        prompt = goal?.status === "active" ? createGoalPrompt(goal) : managementPrompt("No paused goal to resume.", goal)
        await showToast(goal?.status === "active" ? "Goal resumed" : "No paused goal", goal?.status === "active" ? "success" : "info")
      }

      if (parsed.kind === "clear") {
        const goal = await updateState((state) => {
          const stored = state.goals[key(sessionID)]
          if (!stored) return undefined
          stored.status = "cleared"
          stored.updatedAt = now()
          stored.activeSince = undefined
          return { ...stored }
        })
        continuationPending.delete(sessionID)
        continuationInFlight.delete(sessionID)
        prompt = managementPrompt(goal ? "Goal cleared." : "No goal to clear.", goal)
        await showToast(goal ? "Goal cleared" : "No goal to clear", "info")
      }

      if (parsed.kind === "create") {
        const goal = await updateState((state) => {
          const created: Goal = {
            id: randomUUID(),
            sessionID,
            objective: parsed.objective,
            status: "active",
            createdAt: now(),
            updatedAt: now(),
            tokenBudget: parsed.tokenBudget,
            tokensUsed: 0,
            timeUsedMs: 0,
            activeSince: now(),
            accountedAssistantTokens: {},
          }
          state.goals[key(sessionID)] = created
          return { ...created }
        })
        prompt = createGoalPrompt(goal)
        await showToast("Goal created", "success")
      }

      output.parts.splice(0, output.parts.length, textPart(prompt) as any)
    },

    async "experimental.chat.system.transform"(input, output) {
      if (!input.sessionID) return
      const goal = await getGoal(input.sessionID)
      if (!goal || goal.status !== "active") return
      output.system.push(`Active persistent OpenCode goal:\n${statusLine(goal)}\n\nGoal-mode instructions:\n- Treat the active goal as the main objective unless the user explicitly interrupts or changes direction.\n- Continue through clear next actions instead of asking the user to type continue.\n- Use get_goal if you need to inspect current goal state.\n- Call update_goal only when the goal is verified completed or genuinely blocked.\n- Do not mark a goal complete because the token budget is exhausted.`)
    },

    async "experimental.session.compacting"(input, output) {
      const goal = await getGoal(input.sessionID)
      if (!goal || goal.status !== "active") return
      await updateState((state) => {
        const stored = state.goals[key(input.sessionID)]
        if (stored) stored.suppressNextIdleContinuation = true
      })
      output.context.push(`Active persistent OpenCode goal to preserve through compaction:\n${statusLine(goal)}`)
    },

    async event({ event }) {
      try {
        const anyEvent = event as any
        const type = anyEvent.type
        const properties = anyEvent.properties ?? anyEvent
        const sessionID = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID

        if (type === "message.updated" && sessionID && properties.info?.role === "assistant") {
          await updateState((state) => {
            const goal = state.goals[key(sessionID)]
            if (!goal || goal.status === "cleared") return
            const total = properties.info.tokens?.total
            const fallback = (properties.info.tokens?.input ?? 0) + (properties.info.tokens?.output ?? 0) + (properties.info.tokens?.reasoning ?? 0)
            const tokens = typeof total === "number" ? total : fallback
            const messageID = properties.info.id
            goal.accountedAssistantTokens ??= {}
            const previous = goal.accountedAssistantTokens[messageID] ?? 0
            if (tokens > previous) {
              goal.tokensUsed += tokens - previous
              goal.accountedAssistantTokens[messageID] = tokens
            }
            if (goal.activeSince) {
              const current = now()
              goal.timeUsedMs += Math.max(0, current - goal.activeSince)
              goal.activeSince = current
            }
            goal.lastAssistantMessageID = properties.info.id
            if (goal.continuationQueuedAt && (!goal.lastContinuationMessageID || goal.lastContinuationHadToolCalls !== true)) {
              goal.lastContinuationMessageID = properties.info.id
              goal.lastContinuationHadToolCalls = false
            }
            goal.updatedAt = now()
          })
        }

        if (type === "message.part.updated" && sessionID && properties.part?.type === "tool") {
          await updateState((state) => {
            const goal = state.goals[key(sessionID)]
            if (!goal || goal.status !== "active") return
            if (goal.lastContinuationMessageID && properties.part.messageID === goal.lastContinuationMessageID) {
              goal.lastContinuationHadToolCalls = true
              goal.updatedAt = now()
            }
          })
        }

        if (type === "session.status" && sessionID && properties.status?.type === "idle") {
          await queueContinuation(sessionID)
        }

        if (type === "session.idle" && sessionID) {
          await queueContinuation(sessionID)
        }

      } catch (error) {
        console.error(`[goal-plugin] Unhandled error processing event "${(event as any)?.type}":`, error)
        try { await showToast("Goal plugin error — check console", "error") } catch {}
      }
    },
  }
}

export default {
  id: "opencode-plugin-goal",
  server: GoalPlugin,
}
