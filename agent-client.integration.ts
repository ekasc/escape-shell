import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

import { EscapeAgentClient } from './agent-client'
import type { AgentEvent } from './agent-client'

describe('EscapeAgentClient', () => {
  it('streams a prompt through a real child RPC process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'escape-rpc-test-'))
    const command = join(directory, 'escape-rpc')
    writeFileSync(
      command,
      `#!/bin/sh
printf '%s\\n' '{"type":"response","command":"prompt","success":true,"id":"gui-1"}'
printf '%s\\n' '{"type":"agent_start"}'
printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}'
printf '%s\\n' '{"type":"agent_settled","reason":"done"}'
`,
      { mode: 0o755 },
    )

    const client = new EscapeAgentClient({ command, cwd: process.cwd() })
    const events: AgentEvent[] = []
    try {
      await client.send('hello', [], (event) => events.push(event))
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      client.close()
    }

    expect(client.mode).toBe('engine')
    expect(events).toEqual([
      { kind: 'started' },
      { kind: 'text_delta', text: 'hello' },
      { kind: 'settled', reason: 'done' },
    ])
  })

  it("reads a message's attachment blocks back out of the transcript", async () => {
    // The parser joined only the text blocks, so a screenshot came back as its
    // caption and a message that was *only* a screenshot came back as nothing.
    // Both cases are driven through the real wire format here, because a stubbed
    // client in app.test.tsx sits above the parser and cannot reach it.
    const directory = mkdtempSync(join(tmpdir(), 'escape-rpc-attach-'))
    const command = join(directory, 'escape-rpc')
    const page = {
      type: 'response',
      command: 'get_page',
      success: true,
      id: 'gui-1',
      data: {
        entries: [
          {
            type: 'message',
            id: 'm1',
            message: {
              role: 'user',
              content: [
                { type: 'text', text: 'look at this' },
                { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo', source: '/tmp/shot.png' },
              ],
            },
          },
          {
            type: 'message',
            id: 'm2',
            message: {
              role: 'user',
              content: [{ type: 'media', mimeType: 'application/pdf', data: 'JVBER', source: '/tmp/spec.pdf' }],
            },
          },
          {
            type: 'message',
            id: 'm3',
            message: { role: 'user', content: [{ type: 'text', text: '' }] },
          },
        ],
        hasMore: false,
        earliestId: 'm1',
      },
    }
    writeFileSync(
      command,
      `#!/bin/sh
printf '%s\\n' '${JSON.stringify(page)}'
`,
      { mode: 0o755 },
    )

    const client = new EscapeAgentClient({ command, cwd: process.cwd() })
    try {
      const result = await client.getTranscriptPage('', 50)
      const byId = new Map(result.messages.map((message) => [message.id, message]))

      expect(byId.get('m1')?.content).toBe('look at this')
      expect(byId.get('m1')?.attachments).toEqual([
        { kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo', source: '/tmp/shot.png' },
      ])

      // A message that is only a file is a message. Before, the empty content
      // dropped it and the picture went with it.
      expect(byId.has('m2')).toBe(true)
      expect(byId.get('m2')?.content).toBe('')
      expect(byId.get('m2')?.attachments).toEqual([
        { kind: 'media', mimeType: 'application/pdf', data: 'JVBER', source: '/tmp/spec.pdf' },
      ])

      // No text and no attachment is not a message.
      expect(byId.has('m3')).toBe(false)
    } finally {
      client.close()
    }
  })
  it("carries a sent message's attachment bytes on its message_end", async () => {
    // The shell knows the paths it dropped but not the bytes, so the engine hands
    // them back with the event that announces the message. Without this the
    // picture only appears once the transcript is next read.
    const directory = mkdtempSync(join(tmpdir(), 'escape-rpc-evt-'))
    const command = join(directory, 'escape-rpc')
    writeFileSync(
      command,
      `#!/bin/sh
printf '%s\\n' '{"type":"response","command":"prompt","success":true,"id":"gui-1"}'
printf '%s\\n' '{"type":"agent_start"}'
printf '%s\\n' '{"type":"message_end","role":"user","messageId":"m1","attachments":[{"kind":"image","mimeType":"image/png","data":"iVBORw0KGgo","source":"/tmp/shot.png"}]}'
printf '%s\\n' '{"type":"agent_settled","reason":"done"}'
`,
      { mode: 0o755 },
    )

    const client = new EscapeAgentClient({ command, cwd: process.cwd() })
    const events: AgentEvent[] = []
    try {
      await client.send('look at this', ['/tmp/shot.png'], (event) => events.push(event))
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      client.close()
    }

    const ended = events.find((event) => event.kind === 'message_end')
    expect(ended?.kind === 'message_end' && ended.attachments).toEqual([
      { kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo', source: '/tmp/shot.png' },
    ])
  })
})

