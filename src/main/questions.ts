import * as crypto from 'node:crypto'
import { log } from './log'

// ask_user bridge: the MCP server (separate process) POSTs a question, the renderer
// answers via REST. Pending calls live here until answered / cancelled / timed out.

export interface AskUserQuestion {
  question: string
  options: string[]
  multiSelect?: boolean
}

export interface QuestionResult {
  cancelled?: boolean
  answers?: string[][]
}

interface PendingQuestion {
  id: string
  questions: AskUserQuestion[]
  resolve: (result: QuestionResult) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingQuestion>()
const QUESTION_TIMEOUT_MS = 10 * 60 * 1000

export function askUser(
  questions: AskUserQuestion[],
  onCreated?: (entry: { id: string; questions: AskUserQuestion[] }) => void
): Promise<QuestionResult> {
  const id = crypto.randomUUID()
  return new Promise<QuestionResult>((resolve) => {
    const entry: PendingQuestion = {
      id,
      questions,
      resolve: (result) => {
        clearTimeout(entry.timer)
        pending.delete(id)
        resolve(result)
      },
      timer: setTimeout(() => {
        log('warn', 'questions', `question ${id} timed out after ${QUESTION_TIMEOUT_MS / 60000}min`)
        entry.resolve({ cancelled: true })
      }, QUESTION_TIMEOUT_MS)
    }
    pending.set(id, entry)
    log('info', 'questions', `ask_user queued ${id} (${questions.length} question(s))`)
    onCreated?.({ id, questions })
  })
}

export function answerQuestion(id: string, answers: string[][], cancelled = false): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  entry.resolve(cancelled ? { cancelled: true } : { answers })
  return true
}

export function cancelAllQuestions(): void {
  for (const entry of [...pending.values()]) entry.resolve({ cancelled: true })
}

export function pendingQuestionCount(): number {
  return pending.size
}
