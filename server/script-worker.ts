// Worker-thread entry for one script in the console server: the same sandbox the page runs in a Web Worker.
// Unlike the browser, a worker thread can reach Node's APIs, so only run scripts you trust.

import { parentPort } from 'node:worker_threads'
import type { HostToScript } from '../src/scripts/messages.ts'
import { runSandbox } from '../src/scripts/sandbox.ts'

const port = parentPort!
runSandbox({
  post: (m) => port.postMessage(m),
  onMessage: (fn) => port.on('message', (m: HostToScript) => fn(m)),
})
