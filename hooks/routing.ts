import type { RouteItem } from '../types'

const ME = 'me'
const SHORT_REPLY = /^(yes|no|ok|okay|y|n|sure|correct|both|none|all|skip|later|same)\b/i
// A go word, with at most a few softeners around it: "proceed then", "ok go ahead", "yes please".
const APPROVAL =
  /^((ok|okay|yes|yep|sure|alright|fine|then|now|please|so)\s+){0,2}(go|go ahead|ok|okay|yes|y|yep|proceed|approved?|run( it)?|do it|start|lgtm|looks good)(\s+(then|now|please|thanks|with it|ahead|it))*$/i
const CHANGE = /(\d{1,2})\s*(?:→|->|=>|to)\s*`?([\w:.-]+)`?/gi

/** The numbered items of a prompt (`1. …`, `2) …`, inline or one per line); [] for fewer than two. */
export function numberedItems(text: string): { n: number; text: string }[] {
  const marks = [...text.matchAll(/(?:^|\s)(\d{1,2})[.)]\s*(?=\S)/g)]
  const items: { n: number; text: string }[] = []
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!
    const n = Number(mark[1])
    // Count only a run 1, 2, 3 … so "version 3.47" or "step 10." do not start a list.
    if (n !== items.length + 1) continue
    const start = mark.index! + mark[0].length
    const end = marks.slice(i + 1).find(next => Number(next[1]) === n + 1)?.index ?? text.length
    items.push({ n, text: text.slice(start, end).replace(/\s+/g, ' ').trim() })
  }
  return items.length >= 2 ? items : []
}

/** True when the items read as answers to Claude's questions ("1.yes 2.yes"), not tasks. */
export function isAnswerList(items: readonly { text: string }[]): boolean {
  return items.filter(item => SHORT_REPLY.test(item.text)).length * 2 >= items.length
}

export type PlanLine = { n: number; agent: string; note?: string; after: number[] }

/** The `N → agent — note (after M)` lines of Claude's proposal. */
export function planLines(answer: string): PlanLine[] {
  const lines: PlanLine[] = []
  for (const line of answer.split('\n')) {
    const m = /^[\s>*\-|`]*(\d{1,2})\s*(?:→|->|=>)\s*`?([\w:.-]+)`?\s*(?:[—–:-]+\s*(.*?))?\s*$/.exec(line)
    if (m === null) continue
    let note = m[3]?.replace(/[`*]/g, '').trim()
    const afterMatch = note === undefined ? null : /\(after ([^)]+)\)\s*$/i.exec(note)
    const after = afterMatch === null ? [] : [...afterMatch[1]!.matchAll(/\d+/g)].map(d => Number(d[0]))
    if (afterMatch !== null) note = note!.slice(0, afterMatch.index).trim()
    lines.push({ n: Number(m[1]), agent: m[2]!.toLowerCase() === ME ? ME : m[2]!, note: note || undefined, after })
  }
  return lines
}

/** The person's reply to a proposal: approved (with reassignments), cancelled, or something else. */
export function readReply(text: string): { kind: 'approve' | 'cancel' | 'other'; changes: { n: number; agent: string }[] } {
  const changes = [...text.matchAll(CHANGE)].map(m => ({
    n: Number(m[1]),
    agent: m[2]!.toLowerCase() === ME ? ME : m[2]!,
  }))
  const bare = (value: string) => value.replace(/[.,;!?]+/g, ' ').replace(/\s+/g, ' ').trim()
  const trimmed = bare(text)
  if (/^(no|cancel|stop|abort|nope)$/i.test(trimmed)) return { kind: 'cancel', changes: [] }
  // Approval is the whole reply: a go word, or reassignments with a few words around them.
  // "yes, add X" is a new request, not a go.
  const rest = bare(text.replace(CHANGE, ' ').replace(/\b(and|then|also)\b/gi, ' '))
  if (APPROVAL.test(trimmed) || (changes.length > 0 && rest.split(' ').filter(Boolean).length <= 3)) {
    return { kind: 'approve', changes }
  }
  return { kind: 'other', changes: [] }
}

/** Items with a plan's lines and the person's changes applied. */
export function applyPlan(items: readonly RouteItem[], lines: readonly { n: number; agent: string; note?: string; after?: number[] }[]): RouteItem[] {
  return items.map(item => {
    const line = [...lines].reverse().find(one => one.n === item.n)
    if (line === undefined) return item
    return { ...item, agent: line.agent, note: line.note ?? item.note, after: line.after ?? item.after }
  })
}

export function planText(items: readonly RouteItem[]): string {
  return items
    .map(item => {
      const after = item.after.length > 0 ? ` (after ${item.after.join(', ')})` : ''
      return `  ${item.n} → ${item.agent ?? ME} — ${item.note ?? item.text}${after}`
    })
    .join('\n')
}

export function proposalContext(count: number, agents: readonly { name: string; model: string }[]): string {
  const names = agents.map(one => `${one.name} (${one.model})`).join(', ')
  return [
    `[agent-router] This prompt holds ${count} numbered items, and the person wants to approve how they are split before any work starts.`,
    'Do no work and make no tool calls yet. Reply with the routing plan below and stop, then wait for their answer:',
    '',
    'Proposed routing:',
    '  1 → <agent name or me> — <the item in a few words>',
    '  2 → <agent name or me> — <the item in a few words> (after 1)',
    '',
    `One line per item, in order. Use one of the project's subagents: ${names}; or "me" for an item you will do yourself. Add "(after N)" when an item has to wait for another. End with: Reply "go", or change it (e.g. "2 → me").`,
    'If the items are not tasks (say, they answer your earlier questions), ignore this note and reply normally.',
  ].join('\n')
}

export function approvalContext(items: readonly RouteItem[], changed: boolean): string {
  return [
    `[agent-router] The person approved this routing${changed ? ', with their changes applied' : ''}:`,
    planText(items),
    '',
    'Carry it out now. Delegate each item to its agent with the Agent tool, starting the Agent call\'s `description` with "#<item number> " (e.g. "#2 Run backend suite") so the person can track it. Respect each "(after N)", run the rest in parallel, and do the items marked "me" yourself.',
  ].join('\n')
}
