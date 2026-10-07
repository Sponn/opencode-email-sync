import { existsSync, lstatSync, realpathSync, statSync, accessSync, constants, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export function targetPath(path: string): string {
  const absolute = resolve(path)
  try { return realpathSync(absolute) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A dangling symlink must not be overwritten as if it were absent.
    let dangling = false
    try { dangling = lstatSync(absolute).isSymbolicLink() }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
    if (dangling) throw new Error('Configuration symlink target does not exist')
    let parent = dirname(absolute)
    while (!existsSync(parent)) parent = dirname(parent)
    return resolve(realpathSync(parent), relative(parent, absolute))
  }
}
export function preflightDirectory(path: string) {
  let ancestor = resolve(path)
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  if (!statSync(ancestor).isDirectory()) throw new Error('Installation directory conflicts with an existing file')
  accessSync(ancestor, constants.W_OK | constants.X_OK)
}
export function preflightFile(path: string) {
  const target = targetPath(path)
  if (existsSync(target) && !statSync(target).isFile()) throw new Error('Installation file conflicts with an existing directory')
  preflightDirectory(dirname(target))
}
export function atomicText(path: string, text: string, mode: number) {
  const target = targetPath(path)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, text, { mode, flag: 'wx' }); renameSync(temporary, target) }
  finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
