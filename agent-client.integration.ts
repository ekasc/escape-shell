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
      await client.send('hello', (event) => events.push(event))
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
})
