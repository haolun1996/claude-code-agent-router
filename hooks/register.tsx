import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { RosterAgent, RouteItem, Routing } from '../types'
import { clip, definitionOf, delegationSection, merge, purposeOf } from './roster'
import type { Definition } from './roster'
import { applyPlan, approvalContext, isAnswerList, numberedItems, planLines, proposalContext, readReply } from './routing'

const snapshot = atom({ plugin: 'agent-router', key: 'snapshot' } as const, {
  project: '',
  isHinting: true,
  agents: [],
})

const routing = atom({ plugin: 'agent-router', key: 'routing' } as const, null)
const now = atom({ plugin: 'agent-router', key: 'now' } as const, 0)
const paneUp = atom({ plugin: 'agent-router', key: 'paneUp' } as const, false)
const focusRow = atom({ plugin: 'agent-router', key: 'focusRow' } as const, null)

const PANE = 'routing'

const HINT_KEY = 'hint'
const APPROVE_KEY = 'approve'
const ME = 'me'
const SPIN = ['◐', '◓', '◑', '◒']
const FRESH_MS = 15_000
const AGENT_TOOLS = ['Agent', 'Task']

type $ = EngineInterface

let cache: { cwd: string; at: number; agents: Definition[] } | undefined

async function readFolder($: $, folder: string, scope: Definition['scope']): Promise<Definition[]> {
  if (!(await $.fs.exists(folder))) return []
  const found: Definition[] = []
  for (const entry of await $.fs.list(folder)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
    try {
      const one = definitionOf(await $.fs.read(`${folder}/${entry.name}`), scope, entry.name)
      if (one !== undefined) found.push(one)
    } catch {
      // An unreadable file is left off the roster.
    }
  }
  return found
}

/** The project's and the person's own agent definitions, re-read at most every few seconds. */
async function definitions($: $, force = false): Promise<Definition[]> {
  const cwd = await $.session.cwd()
  if (!force && cache !== undefined && cache.cwd === cwd && Date.now() - cache.at < FRESH_MS) return cache.agents
  const home = await $.env.get('HOME')
  const project = await readFolder($, `${cwd}/.claude/agents`, 'project')
  const user = home === undefined ? [] : await readFolder($, `${home}/.claude/agents`, 'user')
  cache = { cwd, at: Date.now(), agents: merge(project, user) }
  return cache.agents
}

const isHinting = async ($: $) => (await $.store.get(HINT_KEY)) !== false
const isApproving = async ($: $) => (await $.store.get(APPROVE_KEY)) !== false

const setItems = ($: $, fn: (item: RouteItem) => RouteItem) =>
  update($, routing, current => (current === null ? null : settle({ ...current, items: current.items.map(fn) })))

/** A running plan whose items have all settled is done. */
function settle(current: Routing): Routing {
  if (current.phase !== 'running') return current
  const open = current.items.some(item => item.status === 'planned' || item.status === 'running')
  return open ? current : { ...current, phase: 'done' }
}

/** Marks the waiting plan approved, with any reassignments, and says so in the note Claude reads. */
async function approve($: $, current: Routing, changes: readonly { n: number; agent: string }[]): Promise<string> {
  const clock = Date.now()
  const items = applyPlan(current.items, changes).map(item => {
    const agent = item.agent ?? ME
    return agent === ME ? { ...item, agent, status: 'running' as const, startedAt: clock } : { ...item, agent }
  })
  await update($, routing, () => ({ phase: 'running' as const, items }))
  await closePicker($).catch(() => undefined)
  return approvalContext(items, changes.length > 0 || items.some(item => item.edited))
}

/** Opens the plan in a panel holding the keyboard, so the person picks without a click first. */
async function openPicker($: $, rows: number) {
  // A panel left open but unplaced only retitles on the next open: close it so that open starts fresh.
  if ((await $.ui.panes()).some(pane => pane.id === PANE && !pane.isPlaced)) await $.ui.close({ id: PANE })
  const opened = await $.ui.open({ id: PANE, title: 'Routing', focus: true, closeOnEscape: true, rows })
  if (!opened.isPlaced) await $.ui.close({ id: PANE })
  await update($, paneUp, () => opened.isPlaced)
  return opened
}

async function closePicker($: $) {
  await update($, focusRow, () => null)
  if (!(await read($, paneUp))) return
  await update($, paneUp, () => false)
  await $.ui.close({ id: PANE })
}

function elapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

const MODEL_COLOR: Record<string, string> = { haiku: 'success', sonnet: 'suggestion', opus: 'claude' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'roster',
      description: "List this project's subagents: model, purpose, what's running",
      argumentHint: '[hint on|off] [approve on|off]',
    })
    $.clock.every(1000, () => {
      void (async () => {
        const current = await read($, routing)
        if (current?.items.some(item => item.status === 'running')) await update($, now, () => Date.now())
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'roster' }, async ($, e) => {
    const args = e.args.trim().toLowerCase()
    if (args === 'hint on' || args === 'hint off') {
      await $.store.set(HINT_KEY, args === 'hint on')
      return {
        text:
          args === 'hint on'
            ? 'Delegation hint on: Claude is told to hand matching work to these agents.'
            : 'Delegation hint off: Claude decides on its own when to delegate.',
      }
    }

    if (args === 'approve on' || args === 'approve off') {
      await $.store.set(APPROVE_KEY, args === 'approve on')
      if (args === 'approve off') await update($, routing, () => null)
      return {
        text:
          args === 'approve on'
            ? 'Routing approval on: a prompt with numbered items gets a proposed routing to approve before work starts.'
            : 'Routing approval off: numbered prompts start at once.',
      }
    }

    const found = await definitions($, true)
    const live = await $.agent.list()
    const agents: RosterAgent[] = found.map(one => ({
      ...one,
      running: live.filter(info => info.type === one.name && ['running', 'pending', 'waiting'].includes(info.status)).length,
      finished: live.filter(info => info.type === one.name && info.status === 'completed').length,
    }))
    const cwd = await $.session.cwd()
    const hinting = await isHinting($)
    await update($, snapshot, () => ({ project: cwd.split('/').pop() ?? cwd, isHinting: hinting, agents }))

    if (agents.length === 0) {
      return { text: `No subagents defined for ${cwd} (looked in .claude/agents and ~/.claude/agents).` }
    }
    // The text is what the model reads too: a plain list it can act on.
    const lines = agents.map(
      one =>
        `- ${one.name} (${one.model}, ${one.scope})${one.running > 0 ? ` — ${one.running} running` : ''}: ${purposeOf(one.description, 160)}`,
    )
    return { text: [`Subagents for ${cwd}:`, ...lines].join('\n') }
  })

  // Tells the main loop, the one that holds the Agent tool, which agents to hand work to.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.some(tool => AGENT_TOOLS.includes(tool))) return composed
    if (!(await isHinting($))) return composed
    const agents = await definitions($)
    if (agents.length === 0) return composed
    return {
      sections: [
        ...composed.sections,
        { id: 'agent-router:delegation', text: delegationSection(agents), scope: 'session' as const },
      ],
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'CommandOutput', props: { command: 'roster' } }, async ($, e, next) => {
    if (e.props.isErrored || e.props.args.trim() !== '') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const shot = await read($, snapshot)
    if (shot.agents.length === 0) return next(e)
    const width = Math.max(40, e.viewport?.columns ?? 100)
    const nameWidth = Math.min(18, Math.max(...shot.agents.map(one => one.name.length)) + 1)
    const purposeWidth = Math.max(10, width - nameWidth - 30)
    const running = shot.agents.reduce((sum, one) => sum + one.running, 0)

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>Agents · {shot.project}</Text>
          <Text dimColor>
            {'  '}
            {shot.agents.length} defined{running > 0 ? ` · ${running} running` : ''} · delegation hint{' '}
          </Text>
          <Text color={shot.isHinting ? 'success' : 'inactive'}>{shot.isHinting ? 'on' : 'off'}</Text>
        </Text>
        {shot.agents.map(one => (
          <Box key={one.name} flexDirection="row">
            <Text color={one.running > 0 ? 'warning' : 'inactive'}>{one.running > 0 ? ' ● ' : ' ○ '}</Text>
            <Text bold>{one.name.padEnd(nameWidth)}</Text>
            <Text color={MODEL_COLOR[one.model] ?? 'text'}>{one.model.padEnd(8)}</Text>
            <Text dimColor>{(one.scope === 'user' ? 'user' : '').padEnd(6)}</Text>
            <Text dimColor wrap="truncate-end">{clip(purposeOf(one.description, 400), purposeWidth)}</Text>
            {one.running > 0 && <Text color="warning"> {one.running} running</Text>}
          </Box>
        ))}
        <Text dimColor>
          {'   '}/roster hint {shot.isHinting ? 'off' : 'on'} to {shot.isHinting ? 'stop' : 'start'} nudging Claude to delegate · definitions in .claude/agents/
        </Text>
      </Box>
    )
  })

  // A numbered prompt: ask Claude for a routing plan first. The person's next reply approves it.
  on('prompt.submit', async ($, e, next) => {
    if (String(e.origin.kind) !== 'composer' || e.command !== undefined || e.isMeta) return next(e)
    const current = await read($, routing)
    const withNote = (note: string) => next({ ...e, context: [...(e.context ?? []), note] })

    if (current?.phase === 'proposed') {
      const reply = readReply(e.text)
      if (reply.kind === 'approve') return withNote(await approve($, current, reply.changes))
      if (reply.kind === 'cancel') {
        await update($, routing, () => null)
        await closePicker($).catch(() => undefined)
        return next(e)
      }
      // A question or remark leaves the plan waiting; only a new numbered prompt replaces it.
      if (numberedItems(e.text).length === 0) return next(e)
      await update($, routing, () => null)
      await closePicker($).catch(() => undefined)
    } else if (current !== null && current.phase !== 'running') {
      await update($, routing, () => null)
    }

    if (!(await isApproving($))) return next(e)
    const items = numberedItems(e.text)
    if (items.length === 0 || isAnswerList(items)) return next(e)
    const agents = await definitions($)
    if (agents.length === 0) return next(e)
    await update($, routing, () => ({
      phase: 'proposing' as const,
      items: items.map(item => ({ ...item, after: [], status: 'planned' as const })),
    }))
    return withNote(proposalContext(items.length, agents))
  }).catch(($, e, next) => next(e))

  // An approved item starts: Claude tags the Agent call's description with "#<n>".
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const tags = /^((?:\s*#\d{1,2}[,\s]*)+)/.exec(e.description)?.[1]
    const agentId = started.agentId
    if (tags !== undefined && agentId !== undefined) {
      const numbers = [...tags.matchAll(/\d+/g)].map(m => Number(m[0]))
      const plan = await read($, routing)
      if (plan?.phase === 'proposed') {
        // Approved in words the reply reader did not catch: the plan is under way all the same.
        const clock = Date.now()
        await update($, routing, value =>
          value === null
            ? null
            : {
                phase: 'running' as const,
                items: value.items.map(item =>
                  (item.agent ?? ME) === ME ? { ...item, agent: ME, status: 'running' as const, startedAt: clock } : item,
                ),
              },
        )
        await closePicker($).catch(() => undefined)
      }
      await setItems($, item =>
        numbers.includes(item.n)
          ? { ...item, agent: e.subagentType, agentId, status: 'running', startedAt: Date.now() }
          : item,
      )
    }
    return started
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const current = await read($, routing)
    if (current === null) return next(e)
    const clock = Date.now()

    if (e.agentId !== undefined) {
      const status = e.reason === 'answer' ? 'done' : 'failed'
      await setItems($, item => (item.agentId === e.agentId ? { ...item, status, endedAt: clock } : item))
    } else if (current.phase === 'proposing') {
      const lines = planLines(e.answer)
      const isProposed = lines.length > 0 && e.reason === 'answer'
      const items = applyPlan(current.items, lines).map(item => ({ ...item, proposed: item.agent ?? ME }))
      await update($, routing, () => (isProposed ? { phase: 'proposed' as const, items } : null))
      if (isProposed) await openPicker($, current.items.length + 4).catch(() => undefined)
    } else if (current.phase === 'running') {
      // The main turn is over: its own items are done, and an item no agent took was skipped.
      await setItems($, item =>
        item.agent === ME && item.status === 'running'
          ? { ...item, status: e.reason === 'answer' ? 'done' : 'failed', endedAt: clock }
          : item.status === 'planned'
            ? { ...item, status: 'skipped' }
            : item,
      )
    }
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, paneUp, () => false)
    await update($, focusRow, () => null)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, routing)
    if (current === null || e.props.hasSurvey) return next(e)
    // The panel shows a waiting plan; the band takes it back once the panel is closed.
    if (current.phase === 'proposed' && (await read($, paneUp))) return next(e)
    return drawRouting($, e, current, { width: e.props.bodyColumns, rows: e.props.maxRows, site: 'band' })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const current = await read($, routing)
    const { Text } = $.ui.resolve(e)
    if (current === null || current.phase !== 'proposed') return <Text dimColor>No plan is waiting.</Text>
    return drawRouting($, e, current, { width: e.props.bodyColumns, rows: e.props.scroll.bodyRows || 20, site: 'pane' })
  })
}

type Site = Parameters<EngineInterface['ui']['resolve']>[0]

/** The routing table, in the band above the prompt or in its own panel. */
async function drawRouting(
  $: $,
  e: Site,
  current: Routing,
  layout: { width: number; rows: number; site: 'band' | 'pane' },
): Promise<RenderElement> {
  {
    const { Box, Text, Button } = $.ui.resolve(e)
    const clock = Math.max(await read($, now), Date.now())
    const models = new Map((await definitions($)).map(one => [one.name, one.model]))
    const choices = [...models.keys(), ME]
    const assign = (n: number, agent: string) =>
      update($, routing, value =>
        value === null || value.phase !== 'proposed'
          ? value
          : {
              ...value,
              items: value.items.map(item =>
                item.n === n ? { ...item, agent, edited: agent !== (item.proposed ?? item.agent ?? ME) } : item,
              ),
            },
      )
    const startRow = await read($, focusRow)
    // A row's digit puts the keyboard on the row's number, a Button, so the shortcuts stay armed (a focused
    // picker takes every key). The same digit again steps into the picker. Where this site cannot take the
    // keys, the panel opens with them instead (a press of the person's may open it at any width).
    const jump = async (n: number, requestId: string) => {
      const target = (await read($, focusRow)) === n ? `pick-${n}` : `row-${n}`
      const moved = await $.ui.focus({ requestId, key: target }).catch((error: unknown) => ({ deny: String(error) }))
      if (moved.deny === undefined) {
        await update($, focusRow, () => (target === `row-${n}` ? n : null))
        return
      }
      try {
        await update($, focusRow, () => n)
        const opened = await openPicker($, current.items.length + 4)
        if (!opened.isPlaced) $.ui.toast(`Routing panel could not open (${opened.reason}): ctrl+x tab to use the band`)
      } catch (error) {
        $.ui.toast(`Routing panel could not open: ${String(error)}`)
      }
    }
    // While a plan waits for approval, each row's assignee is a picker (a cycling button where the surface has none).
    const picker = (item: RouteItem) => {
      const chosen = item.agent ?? ME
      if (e.surface !== 'mobile') {
        const { Select } = $.ui.resolve(e)
        return (
          <Select
            key={`pick-${item.n}`}
            value={chosen}
            options={choices.map(name => ({
              value: name,
              label: name === ME ? 'main (Claude itself)' : `${name} · ${models.get(name) ?? ''}`,
            }))}
            onSelect={async (value, picked) => {
              await assign(item.n, value)
              // On to the next row's picker, and to Go after the last.
              const following = current.items.find(other => other.n > item.n)
              // Best effort: the band may have lost the keyboard meanwhile.
              await update($, focusRow, () => following?.n ?? null)
              await $.ui.focus({ requestId: picked.requestId, key: following === undefined ? 'go' : `row-${following.n}` }).catch(
                () => undefined,
              )
            }}
          />
        )
      }
      const nextChoice = choices[(choices.indexOf(chosen) + 1) % choices.length]!
      return (
        <Button key={`pick-${item.n}`} plain onPress={() => assign(item.n, nextChoice)}>
          {chosen === ME ? 'main' : chosen} ▸
        </Button>
      )
    }

    const width = Math.max(30, layout.width)
    const spin = SPIN[Math.floor(clock / 1000) % SPIN.length]!
    const count = (status: RouteItem['status']) => current.items.filter(item => item.status === status).length
    const nameWidth = Math.min(18, Math.max(6, ...current.items.map(item => (item.agent ?? '').length)) + 1)

    const phase =
      current.phase === 'proposing'
        ? 'Claude is planning…'
        : current.phase === 'proposed'
          ? 'waiting for your go'
          : current.phase === 'running'
            ? [`${count('running')} running`, `${count('done')} done`, count('failed') > 0 ? `${count('failed')} failed` : '']
                .filter(Boolean)
                .join(' · ')
            : 'all settled'

    const rows = current.items.slice(0, Math.max(1, layout.rows - 2)).map(item => {
      const isMe = item.agent === ME
      const [mark, color] =
        item.status === 'running'
          ? [isMe ? '●' : spin, 'warning']
          : item.status === 'done'
            ? ['✓', 'success']
            : item.status === 'failed'
              ? ['✗', 'error']
              : item.status === 'skipped'
                ? ['–', 'inactive']
                : [current.phase === 'proposing' ? '·' : '→', 'suggestion']
      const who = item.agent === undefined ? '' : isMe ? 'main' : item.agent
      const model = isMe || item.agent === undefined ? '' : (models.get(item.agent) ?? '')
      const after = item.after.length > 0 && item.status === 'planned' ? ` after ${item.after.join(',')}` : ''
      const time =
        item.startedAt === undefined ? '' : ` ${elapsed((item.endedAt ?? clock) - item.startedAt)}`
      const textWidth = Math.max(8, width - nameWidth - 8 - 6 - after.length - time.length)
      return (
        <Box key={`route-${item.n}`} flexDirection="row">
          {current.phase === 'proposed' && item.n <= 9 ? (
            // A bare digit in an empty prompt box presses this, as does the digit while the site has the keys.
            <Button
              key={`row-${item.n}`}
              plain
              hotkey={String(item.n)}
              autoFocus={layout.site === 'pane' && startRow === item.n ? true : undefined}
              onPress={pressed => jump(item.n, pressed.requestId)}
            >
              <Text color={color}>{mark}</Text>
            </Button>
          ) : (
            <Text dimColor>{String(item.n).padStart(2)} </Text>
          )}
          {current.phase === 'proposed' && item.n <= 9 ? <Text> </Text> : <Text color={color}>{mark} </Text>}
          {current.phase === 'proposed' ? (
            picker(item)
          ) : (
            <Text bold color={isMe ? 'claude' : undefined}>
              {who.padEnd(nameWidth)}
            </Text>
          )}
          {current.phase === 'proposed' ? (
            <Text color="suggestion">{item.edited ? ' ✎ ' : '   '}</Text>
          ) : (
            <Text dimColor>{model.padEnd(7)}</Text>
          )}
          <Text wrap="truncate-end">{clip(item.note ?? item.text, textWidth)}</Text>
          <Text dimColor>
            {after}
            {time}
          </Text>
        </Box>
      )
    })

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text bold>Routing</Text>
          <Text dimColor>
            · {current.items.length} items · {phase}
          </Text>
          {current.phase === 'proposed' && (
            <Button
              key="go"
              variant="primary"
              hotkey="g"
              autoFocus={layout.site === 'band' || startRow === null ? true : undefined}
              label="Go"
              onPress={async () => {
                // This plugin's own prompts skip its prompt.submit hook: approve here and send the plan itself.
                const plan = await read($, routing)
                if (plan === null || plan.phase !== 'proposed') return
                await $.prompt.submit({ text: await approve($, plan, []) })
              }}
            />
          )}
          {current.phase !== 'running' && (
            <Button
              key="dismiss"
              hotkey="x"
              label="Dismiss"
              onPress={async () => {
                await update($, routing, () => null)
                await closePicker($).catch(() => undefined)
              }}
            />
          )}
        </Box>
        {rows}
        {current.phase === 'proposed' && (
          <Text dimColor>
            {layout.site === 'pane'
              ? `   1–${Math.min(9, current.items.length)} pick a row, same digit again to change it · g to go · Esc keeps it in the band`
              : `   1–${Math.min(9, current.items.length)} pick a row, same digit again to change it · g to go · or reply "go"`}
          </Text>
        )}
      </Box>
    )
  }
}
