import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { definitionOf, delegationSection, frontmatter, merge } from '../hooks/roster'

const REFACTOR = `---
name: refactor
description: Behaviour-preserving refactors — renames and moves. Use for sweeps.
model: haiku
tools: Read, Edit, Grep
---
You refactor.`

const TESTS = `---
name: backend-tests
description: |
  Runs the Laravel checks
  and reports failures.
model: haiku
---`

const MINE = `---
name: refactor
description: A user-wide refactor agent
model: opus
---`

const FILES: Record<string, string> = {
  '/w/shop/.claude/agents/refactor.md': REFACTOR,
  '/w/shop/.claude/agents/backend-tests.md': TESTS,
  '/home/me/.claude/agents/refactor.md': MINE,
}

/** A file system holding FILES, a session in /w/shop, HOME at /home/me. */
function world(on: On) {
  on('session.cwd', () => ({ value: '/w/shop' }))
  mock.env(on, { HOME: '/home/me' })
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: Object.keys(FILES).some(path => path.startsWith(e.path + '/')) }))
  on('fs.list', (_, e) => ({
    value: Object.keys(FILES)
      .filter(path => path.startsWith(e.path + '/'))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_, e) => ({ value: FILES[e.path] ?? '' }))
  on('agent.list', () => ({
    value: [{ id: 'a1', type: 'refactor', description: 'rename', status: 'running' as const }],
  }))
}

test('reads one-line and block frontmatter', async () => {
  expect(frontmatter(REFACTOR).model).toBe('haiku')
  expect(frontmatter(TESTS).description).toBe('Runs the Laravel checks and reports failures.')
  expect(definitionOf('no frontmatter', 'user', 'loose.md')?.name).toBe('loose')
})

test('a project agent hides a user one of the same name', async () => {
  const project = [definitionOf(REFACTOR, 'project', 'refactor.md')!]
  const user = [definitionOf(MINE, 'user', 'refactor.md')!]
  const merged = merge(project, user)
  expect(merged.length).toBe(1)
  expect(merged[0]!.model).toBe('haiku')
  expect(delegationSection(merged)).toContain('`refactor` (haiku)')
})

test('/roster lists the agents with what runs, for the model and on screen', async ($, on) => {
  world(on)
  const ran = await $.command.run({ command: 'roster', args: '' } as never)
  const text = JSON.stringify(ran)
  expect(text).toContain('refactor (haiku, project)')
  expect(text).toContain('1 running')
  expect(text).toContain('backend-tests')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-router',
      surface,
      component: 'CommandOutput',
      props: { command: 'roster', args: '', text: '', isErrored: false },
    })
    expect(await ui.find({ text: /2 defined · 1 running/ })).toBeDefined()
    expect(await ui.find({ text: /backend-tests/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the delegation hint reaches a loop that holds the Agent tool, and turns off', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  const base = { model: 'opus', promptModel: 'opus', surfaces: [], outputStyle: null, traits: [] }

  const main = await $.prompt.compose({ ...base, tools: ['Agent', 'Bash'] })
  expect(main.sections.at(-1)?.id).toBe('agent-router:delegation')
  expect(main.sections.at(-1)?.text).toContain('`backend-tests` (haiku)')

  const sub = await $.prompt.compose({ ...base, tools: ['Bash'] })
  expect(sub.sections.map(one => one.id)).toEqual(['intro'])

  await $.command.run({ command: 'roster', args: 'hint off' } as never)
  const off = await $.prompt.compose({ ...base, tools: ['Agent'] })
  expect(off.sections.map(one => one.id)).toEqual(['intro'])
})

import { isAnswerList, numberedItems, planLines, readReply } from '../hooks/routing'

test('finds numbered items, inline or one per line, and tells answers from tasks', async () => {
  expect(numberedItems('1. rename Basket 2.run the tests 3) fix the login popup').map(i => i.text)).toEqual([
    'rename Basket',
    'run the tests',
    'fix the login popup',
  ])
  expect(numberedItems('upgrade to flutter 3.47.7 please')).toEqual([])
  expect(isAnswerList(numberedItems('1.yes 2.yes 3. what do you mean'))).toBe(true)
  expect(isAnswerList(numberedItems('1. cloudflare 2. run the mobile app'))).toBe(false)
})

test('reads a proposed plan and the person\'s reply', async () => {
  const plan = planLines('Proposed routing:\n  1 → refactor — Rename Basket\n  2 → backend-tests — Run tests (after 1)\n  3 → me — login popup\nReply "go"')
  expect(plan).toEqual([
    { n: 1, agent: 'refactor', note: 'Rename Basket', after: [] },
    { n: 2, agent: 'backend-tests', note: 'Run tests', after: [1] },
    { n: 3, agent: 'me', note: 'login popup', after: [] },
  ])
  expect(readReply('go').kind).toBe('approve')
  expect(readReply('3 → flutter-mobile').changes).toEqual([{ n: 3, agent: 'flutter-mobile' }])
  expect(readReply('cancel').kind).toBe('cancel')
  expect(readReply('actually, what does Basket mean?').kind).toBe('other')
  expect(readReply('yes add the auto focus to next row').kind).toBe('other')
  expect(readReply('proceed then').kind).toBe('approve')
  expect(readReply('ok go ahead please').kind).toBe('approve')
  expect(readReply('go check the logs first').kind).toBe('other')
  expect(readReply('Go!').kind).toBe('approve')
  expect(readReply('2 → me, 3 → refactor then go').changes.length).toBe(2)
  expect(readReply('2 → me, 3 → refactor then go').kind).toBe('approve')
  expect(readReply('no, change 2 → me').kind).toBe('approve')
})

test('a numbered prompt is proposed, approved with a change, and tracked to the end', async ($, on) => {
  world(on)
  const notes: string[] = []
  on('prompt.submit', (_, e) => {
    notes.push((e.context ?? []).join('\n'))
    return { text: e.text }
  })
  on('agent.spawn', (_, e) => ({ model: 'haiku', agentId: e.description.startsWith('#1') ? 'r1' : 't2' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const submit = (text: string) =>
    $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)
  const done = (answer: string, agentId?: string) =>
    $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', agentId, reason: 'answer' })
  const spawn = (description: string) =>
    $.agent.spawn({
      tool_use_id: description, prompt: description, description, subagentType: description.startsWith('#1') ? 'refactor' : 'backend-tests',
      provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'opus', background: true, fork: false,
    })
  const band = async (check: (ui: { find: (q: { text?: RegExp; key?: string }) => Promise<unknown> }) => Promise<void>) => {
    const ui = await $.ui.mount({
      plugin: 'agent-router',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 90 } as never,
    })
    await check(ui)
    await ui.unmount()
  }

  await submit('1. rename Basket 2. run the backend tests 3. fix the login popup')
  expect(notes.at(-1)).toContain('Proposed routing:')
  await done('Proposed routing:\n  1 → refactor — Rename Basket\n  2 → backend-tests — Run tests (after 1)\n  3 → me — login popup\nReply "go"')
  await band(async ui => {
    expect(await ui.find({ text: /waiting for your go/ })).toBeDefined()
    expect(await ui.find({ key: 'pick-2' })).toBeDefined()
  })

  await submit('2 → me')
  expect(notes.at(-1)).toContain('2 → me')
  expect(notes.at(-1)).toContain('#<item number>')
  await spawn('#1 Rename Basket')
  await band(async ui => {
    expect(await ui.find({ text: /3 running · 0 done/ })).toBeDefined()
  })
  await done('renamed', 'r1')
  await done('all done')
  await band(async ui => {
    expect(await ui.find({ text: /all settled/ })).toBeDefined()
  })
})

test('picking an agent on a row in the band changes the approved plan', async ($, on) => {
  world(on)
  const notes: string[] = []
  on('prompt.submit', (_, e) => {
    notes.push((e.context ?? []).join('\n'))
    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const submit = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)

  await submit('1. rename Basket 2. run the backend tests')
  await $.turn.complete({
    answer: 'Proposed routing:\n  1 → refactor — Rename Basket\n  2 → backend-tests — Run tests',
    durationMs: 1, isAborted: false, turnId: 't', reason: 'answer',
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-router',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 90 } as never,
    })
    expect(await ui.find({ key: 'pick-2' })).toBeDefined()
    if (surface === 'terminal') await ui.select({ key: 'pick-2', value: 'me' })
    await ui.unmount()
  }
  await submit('can the band use arrow keys?')
  expect(notes.at(-1)).toBe('')
  await submit('go')
  expect(notes.at(-1)).toContain('with their changes applied')
  expect(notes.at(-1)).toContain('2 → me')
  expect(notes.at(-1)).toContain('1 → refactor')
})

test('picks on several rows in a row all apply, the keyboard moving on between them', async ($, on) => {
  world(on)
  const notes: string[] = []
  on('prompt.submit', (_, e) => {
    notes.push((e.context ?? []).join('\n'))
    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const submit = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)
  await submit('1. rename Basket 2. run the backend tests')
  await $.turn.complete({
    answer: 'Proposed routing:\n  1 → refactor — Rename Basket\n  2 → backend-tests — Run tests',
    durationMs: 1, isAborted: false, turnId: 't', reason: 'answer',
  })
  const ui = await $.ui.mount({
    plugin: 'agent-router',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 90 } as never,
  })
  // The kit answers no focus move: each pick must still land.
  await ui.select({ key: 'pick-1', value: 'me' })
  await ui.select({ key: 'pick-2', value: 'refactor' })
  await ui.unmount()
  await submit('go')
  expect(notes.at(-1)).toContain('1 → me')
  expect(notes.at(-1)).toContain('2 → refactor')
})

test('a proposal opens in a panel holding the keyboard; the band takes it back on close', async ($, on) => {
  world(on)
  const opened: { focus?: true; closeOnEscape?: true }[] = []
  const closed: string[] = []
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.open', (_, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  await $.prompt.submit({ text: '1. rename Basket 2. run the backend tests', origin: { kind: 'composer' }, wait: false } as never)
  await $.turn.complete({
    answer: 'Proposed routing:\n  1 → refactor — Rename Basket\n  2 → backend-tests — Run tests',
    durationMs: 1, isAborted: false, turnId: 't', reason: 'answer',
  })
  expect(opened.at(-1)?.focus).toBe(true)
  expect(opened.at(-1)?.closeOnEscape).toBe(true)

  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 90 } as never
  const pane = await $.ui.mount({
    plugin: 'agent-router',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'routing',
    props: { title: 'Routing', isFocused: true, bodyColumns: 90, placement: 'inline', scroll: { offset: 0, bodyRows: 12 }, view: {} } as never,
  })
  expect(await pane.find({ key: 'pick-1' })).toBeDefined()
  // Go approves and closes the panel; the band then shows the run.
  await pane.press({ key: 'go' })
  expect(closed).toEqual(['routing'])
  expect(sent.at(-1)).toContain('The person approved this routing')
  await pane.unmount()
  const band = await $.ui.mount({ plugin: 'agent-router', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await band.find({ text: /Routing/ })).toBeDefined()
  expect(await band.find({ key: 'pick-1' })).toBeUndefined()
  await band.unmount()
})

test('re-picking the proposed agent is no change, and the keyboard starts on Go', async ($, on) => {
  world(on)
  const notes: string[] = []
  on('prompt.submit', (_, e) => {
    notes.push((e.context ?? []).join('\n'))
    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const submit = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)
  await submit('1. rename Basket 2. run the backend tests')
  await $.turn.complete({
    answer: 'Proposed routing:\n  1 → refactor — Rename Basket\n  2 → backend-tests — Run tests',
    durationMs: 1, isAborted: false, turnId: 't', reason: 'answer',
  })
  const ui = await $.ui.mount({
    plugin: 'agent-router',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 90 } as never,
  })
  expect((await ui.find({ key: 'go' }))?.props).toMatchObject({ autoFocus: true })
  expect(await ui.find({ key: 'row-2' })).toBeDefined()
  await ui.select({ key: 'pick-1', value: 'refactor' })
  expect(await ui.find({ text: /✎/ })).toBeUndefined()
  await ui.unmount()
  await submit('go')
  expect(notes.at(-1)).toContain('The person approved this routing:')
  expect(notes.at(-1)).not.toContain('with their changes')
})

test('a row digit from the prompt opens the panel with the keyboard on that row', async ($, on) => {
  world(on)
  const opened: { focus?: true }[] = []
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // Opened unasked on the proposal, a narrow terminal leaves it unplaced; opened by the person's key, it shows.
  on('ui.open', (_, e) => {
    opened.push(e)
    return { value: opened.length === 1 ? ({ isPlaced: false, reason: 'narrow' } as never) : { isPlaced: true } }
  })
  const closed: string[] = []
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  await $.prompt.submit({ text: '1. rename Basket 2. run the backend tests', origin: { kind: 'composer' }, wait: false } as never)
  await $.turn.complete({
    answer: 'Proposed routing:\n  1 → refactor — Rename Basket\n  2 → backend-tests — Run tests',
    durationMs: 1, isAborted: false, turnId: 't', reason: 'answer',
  })
  const band = await $.ui.mount({
    plugin: 'agent-router',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 90 } as never,
  })
  // The band holds no keys here, so the digit opens the panel instead.
  expect(closed).toEqual(['routing'])
  await band.press({ key: 'row-2' })
  expect(opened.length).toBe(2)
  expect(opened.at(-1)?.focus).toBe(true)
  await band.unmount()
  const pane = await $.ui.mount({
    plugin: 'agent-router',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'routing',
    props: { title: 'Routing', isFocused: true, bodyColumns: 90, placement: 'inline', scroll: { offset: 0, bodyRows: 12 }, view: {} } as never,
  })
  expect((await pane.find({ key: 'row-2' }))?.props).toMatchObject({ autoFocus: true })
  expect((await pane.find({ key: 'pick-2' }))?.props).not.toMatchObject({ autoFocus: true })
  expect((await pane.find({ key: 'go' }))?.props).not.toMatchObject({ autoFocus: true })
  await pane.unmount()
})
