import { main } from './main.js'

const code = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: t => process.stdout.write(t),
  stderr: t => process.stderr.write(t),
  stdin: process.stdin,
})
process.exitCode = code
