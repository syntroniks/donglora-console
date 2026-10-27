// Web Worker entry for one script in the page: the sandbox, talking to src/scripts/host.ts.

import type { HostToScript, ScriptToHost } from './messages.ts'
import { runSandbox } from './sandbox.ts'

const scope = self as unknown as { postMessage(m: ScriptToHost): void; addEventListener(type: 'message', fn: (e: MessageEvent<HostToScript>) => void): void }

runSandbox({
  post: (m) => scope.postMessage(m),
  onMessage: (fn) => scope.addEventListener('message', (e) => fn(e.data)),
})
