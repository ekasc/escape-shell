/**
 * Fixture sync for the shell's test doubles.
 *
 * Test fixtures here are object literals typed as `AgentClient`, `SessionSummary`
 * and friends. When one of those types gains a field, every literal has to gain
 * it too, and doing that by hand is where things break: a regex wide enough to
 * reach every literal will also reach the literals belonging to some other
 * method, and the damage is silent until typecheck runs, or does not.
 *
 * So this walks the real AST with the TypeScript checker, selects only literals
 * whose *contextual type* is the one asked for, and reports exactly which
 * required properties each one is missing. It edits nothing unless `--write` is
 * passed, and it prints every line it intends to touch first.
 *
 *   bun scripts/fixtures.ts                     report, change nothing
 *   bun scripts/fixtures.ts AgentClient         report for one type
 *   bun scripts/fixtures.ts AgentSession --write  insert the missing properties
 */

import ts from 'typescript'

const [, , typeNameArg, ...flags] = process.argv
const write = flags.includes('--write')

const PLACEHOLDERS: Record<string, string> = {
  boolean: 'false',
  number: '0',
  string: "''",
}

function zeroValue(type: ts.Type): string {
  if (type.isUnion()) {
    // A null or undefined branch means the caller may omit it, so only offer a
    // value when the union has something concrete in it.
    const concrete = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)))
    if (concrete.length === 1) return zeroValue(concrete[0])
    if (concrete.length > 1) return PLACEHOLDERS[String(concrete[0].flags & ts.TypeFlags.Any ? 'string' : '')] ?? "''"
    return "''"
  }
  if (type.flags & ts.TypeFlags.BooleanLike) return 'false'
  if (type.flags & ts.TypeFlags.NumberLike) return '0'
  if (type.flags & ts.TypeFlags.StringLike) return "''"
  // Arrays are the only composite worth filling. An object or a function type
  // gets nothing: guessing here is how a fixture starts lying.
  if (type.symbol && /^(Array|ReadonlyArray)$/.test(type.symbol.name)) {
    const arg = typeArgumentsOf(type)?.[0]
    return arg ? `[${zeroValue(arg)}]` : '[]'
  }
  return "''"
}

function typeArgumentsOf(type: ts.Type): readonly ts.Type[] | undefined {
  const ref = (type as unknown as { typeArguments?: readonly ts.Type[] }).typeArguments
  if (ref) return ref
  const viaChecker = (type as unknown as { aliasTypeArguments?: readonly ts.Type[] }).aliasTypeArguments
  return viaChecker
}

function propTypeName(type: ts.Type): string {
  if (type.flags & ts.TypeFlags.BooleanLike) return 'boolean'
  if (type.flags & ts.TypeFlags.NumberLike) return 'number'
  if (type.flags & ts.TypeFlags.StringLike) return 'string'
  return 'object'
}

/**
 * Every way a name can appear as an object member. A method shorthand is a
 * MethodDeclaration, not a property assignment, so checking only two of these
 * makes a complete literal look empty.
 */
function memberName(member: ts.ObjectLiteralElementLike): string | null {
  if (ts.isSpreadAssignment(member)) return null
  const name = member.name
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.getText()
  return null
}

const configPath = ts.findConfigFile('.', ts.sys.fileExists, 'tsconfig.json')
if (!configPath) {
  console.error('fixtures: no tsconfig.json found')
  process.exit(2)
}
const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, '.')

const program = ts.createProgram(parsed.fileNames, parsed.options)
const checker = program.getTypeChecker()

const wanted = new Set(
  (typeNameArg ? [typeNameArg] : ['AgentClient', 'SessionSummary', 'SkillSummary']).map((n) => n),
)

interface Finding {
  file: string
  line: number
  missing: Array<{ name: string; value: string }>
}

const findings: Finding[] = []
// Literals this tool cannot verify. A generic helper such as
// `skillsResponse<T>(skills: T[])` gives its elements a type *parameter* as the
// contextual type, so there is nothing to check them against. Saying "nothing to
// do" about those would be a lie, so they are counted and reported instead.
let unchecked = 0
let checked = 0

for (const source of program.getSourceFiles()) {
  if (source.isDeclarationFile) continue
  const relative = source.fileName.replace(process.cwd() + '/', '')
  if (!/\.(ts|tsx)$/.test(relative)) continue

  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      // A literal that spreads something else is not an incomplete literal. The
      // spread may supply any property, so filling the rest would add stubs that
      // shadow the real ones. This is the rule that keeps the tool from
      // rewriting a working fixture into a lying one.
      if (node.properties.some((p) => ts.isSpreadAssignment(p))) {
        ts.forEachChild(node, visit)
        return
      }
      const contextual = checker.getContextualType(node)
      if (contextual) {
        const name = (contextual.symbol?.name ?? contextual.aliasSymbol?.name ?? '') as string
        // An anonymous contextual type is what a generic helper produces: the
        // element inherits the type parameter, so there is no name to match on
        // and nothing to check it against. Counted rather than assumed fine.
        if (name === '' || name === '__type' || name === '__object') {
          unchecked += 1
        } else if (wanted.has(name)) {
          checked += 1
          const missing: Array<{ name: string; value: string }> = []
          for (const prop of contextual.getProperties()) {
            if (prop.flags & ts.SymbolFlags.Optional) continue
            const decl = prop.valueDeclaration ?? prop.declarations?.[0]
            if (!decl) continue
            const declType = checker.getTypeOfSymbolAtLocation(prop, decl)
            const already = node.properties.some((p) => memberName(p) === prop.name)
            if (!already) missing.push({ name: prop.name, value: zeroValue(declType) })
          }
          if (missing.length > 0) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart())
            findings.push({ file: relative, line: line + 1, missing })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

const coverage = `  checked ${checked} literal(s) of ${[...wanted].join(', ')}; ${unchecked} other literal(s) had no nameable type (generic helper) and were skipped.\n`

if (findings.length === 0) {
  console.log('fixtures: every checked literal matches its type.')
  process.stdout.write(coverage)
  process.exit(0)
}

for (const f of findings) {
  console.log(`${f.file}:${f.line}  missing ${f.missing.map((m) => m.name).join(', ')}`)
}

if (!write) {
  console.log(`\nfixtures: ${findings.length} literal(s) need work. re-run with --write to insert placeholders.`)
process.stdout.write(coverage)
  process.exit(1)
}

let touched = 0
for (const source of program.getSourceFiles()) {
  const relative = source.fileName.replace(process.cwd() + '/', '')
  const here = findings.filter((f) => f.file === relative)
  if (here.length === 0) continue

  const edits: Array<{ start: number; end: number; insert: string }> = []
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      if (node.properties.some((p) => ts.isSpreadAssignment(p))) {
        ts.forEachChild(node, visit)
        return
      }
      const { line } = source.getLineAndCharacterOfPosition(node.getStart())
      const finding = here.find((f) => f.line === line + 1)
      if (finding) {
        // Insert after the last existing property so the literal keeps its order
        // and a trailing comma stays where it belongs.
        const last = node.properties[node.properties.length - 1]
        const insertAt = last ? last.getEnd() : node.getEnd() - 1
        const text = finding.missing.map((m) => `${m.name}: ${m.value}`).join(', ')
        edits.push({ start: insertAt, end: insertAt, insert: last ? `, ${text}` : text })
        touched += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (edits.length === 0) continue

  const sorted = edits.sort((a, b) => b.start - a.start)
  let out = source.getFullText()
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.insert + out.slice(e.end)
  }
  process.stdout.write(out)
  console.error(`fixtures: updated ${relative}`)
}

console.error(`fixtures: patched ${touched} literal(s) across ${new Set(findings.map((f) => f.file)).size} file(s).`)
console.error('fixtures: now run `bun run typecheck` and `bun run test`.')
