// Matches root-relative POSIX globs against a file list (an analyzer's `ctx.files`, the git-aware list).
// `*` matches within one segment, `**` any number of whole segments (including zero), `?` one character;
// everything else is literal. The result is sorted and has no duplicates.
export function matchFiles(files: readonly string[], globs: readonly string[]): string[] {
  const patterns = globs.map(globToRegExp)
  return [...new Set(files.filter(f => patterns.some(p => p.test(f))))].sort()
}

function globToRegExp(glob: string): RegExp {
  const segments = glob.split('/')
  let source = ''
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1
    if (segment === '**') {
      source += last ? '.*' : '(?:[^/]+/)*'
      return
    }
    source += segment.replace(/[.+^${}()|[\]\\*?]/g, c => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : `\\${c}`))
    if (!last) source += '/'
  })
  return new RegExp(`^${source}$`)
}
