// A deliberately minimal JSON Schema (draft 2020-12) validator: just the
// subset of keywords schema/*.schema.json actually use. There is no
// dependency on ajv or any other package so `node scripts/validate.mjs` runs
// with nothing but a Node.js installation.
//
// Supported keywords: type, const, enum, anyOf, allOf, oneOf, not,
// if/then/else, $ref (local "#/$defs/...", a relative sibling schema file, or
// a pointer into one such as "partner.schema.json#/$defs/name"), properties,
// required, dependentRequired, additionalProperties (boolean or schema),
// propertyNames, minProperties, maxProperties, items, contains, minItems,
// maxItems, uniqueItems, minLength, maxLength, pattern, minimum, maximum,
// format ("uri", "date-time", "date").
//
// Annotations (title, description, $schema, $id, ...) never affect
// validation. Any other keyword throws, so a schema never passes data by
// silently skipping a rule this validator does not know.

import { readFileSync } from 'node:fs'
import path from 'node:path'

const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** Whether text is a calendar date in YYYY-MM-DD form (RFC 3339 full-date). */
export function isDate(text) {
  const match = DATE_PATTERN.exec(text)
  if (!match)
    return false
  const [year, month, day] = match.slice(1).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** Loads and parses a JSON file, throwing a readable error on bad JSON. */
function loadJson(file) {
  const text = readFileSync(file, 'utf8')
  try {
    return JSON.parse(text)
  }
  catch (err) {
    throw new Error(`${file}: invalid JSON: ${err.message}`)
  }
}

/** A resolution context: the current schema document plus where to resolve a
 * relative file $ref from, and a cache so a schema file is parsed once. */
function makeContext(doc, dir, cache = new Map()) {
  return { doc, dir, cache }
}

function resolveRef(ref, ctx) {
  const hash = ref.indexOf('#')
  const file = hash === -1 ? ref : ref.slice(0, hash)
  const pointer = hash === -1 ? '' : ref.slice(hash + 1)

  // A relative sibling schema file, e.g. "entry.schema.json".
  let target = ctx
  if (file) {
    const full = path.resolve(ctx.dir, file)
    if (!ctx.cache.has(full))
      ctx.cache.set(full, loadJson(full))
    target = makeContext(ctx.cache.get(full), path.dirname(full), ctx.cache)
  }

  let node = target.doc
  if (pointer) {
    if (!pointer.startsWith('/'))
      throw new Error(`cannot resolve $ref ${ref}: only JSON pointer fragments are supported`)
    const parts = pointer.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    for (const part of parts) {
      if (node == null || !(part in node))
        throw new Error(`cannot resolve $ref ${ref}: no ${part}`)
      node = node[part]
    }
  }
  return { schema: node, ctx: target }
}

function typeOf(value) {
  if (value === null)
    return 'null'
  if (Array.isArray(value))
    return 'array'
  if (typeof value === 'number')
    return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function matchesType(value, type) {
  const actual = typeOf(value)
  if (type === 'number')
    return actual === 'number' || actual === 'integer'
  return actual === type
}

/**
 * Validates `data` against `schema`, appending "<path>: <message>" strings to
 * `errors`. `instancePath` is a JSON-Pointer-ish path used only for error
 * messages.
 */
const KEYWORDS = new Set([
  // Annotations.
  '$schema', '$id', '$defs', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  // Validation.
  '$ref', 'type', 'const', 'enum', 'anyOf', 'allOf', 'oneOf', 'not', 'if', 'then', 'else',
  'properties', 'required', 'dependentRequired', 'additionalProperties', 'propertyNames', 'minProperties', 'maxProperties',
  'items', 'contains', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'format',
])

const FORMATS = new Set(['uri', 'date-time', 'date'])

/** Whether data matches schema, errors discarded. */
function matches(schema, data, ctx, instancePath) {
  const errors = []
  validateNode(schema, data, ctx, instancePath, errors)
  return errors.length === 0
}

function validateNode(schema, data, ctx, instancePath, errors) {
  if (typeof schema === 'boolean') {
    if (schema === false)
      errors.push(`${instancePath || '/'}: not allowed here`)
    return
  }

  for (const keyword of Object.keys(schema)) {
    if (!KEYWORDS.has(keyword))
      throw new Error(`schema keyword ${JSON.stringify(keyword)} is not supported by scripts/lib/schema-validator.mjs`)
  }
  if (schema.format !== undefined && !FORMATS.has(schema.format))
    throw new Error(`schema format ${JSON.stringify(schema.format)} is not supported by scripts/lib/schema-validator.mjs`)

  // Keywords next to $ref apply as well.
  if (schema.$ref) {
    const { schema: resolved, ctx: nextCtx } = resolveRef(schema.$ref, ctx)
    validateNode(resolved, data, nextCtx, instancePath, errors)
  }

  const label = instancePath || '/'

  if (schema.allOf) {
    for (const sub of schema.allOf)
      validateNode(sub, data, ctx, instancePath, errors)
  }

  if (schema.oneOf) {
    const count = schema.oneOf.filter(sub => matches(sub, data, ctx, instancePath)).length
    if (count !== 1)
      errors.push(`${label}: must match exactly one schema in oneOf, matches ${count}`)
  }

  if (schema.not !== undefined && matches(schema.not, data, ctx, instancePath))
    errors.push(`${label}: must not match the schema in not`)

  if (schema.if !== undefined) {
    const branch = matches(schema.if, data, ctx, instancePath) ? schema.then : schema.else
    if (branch !== undefined)
      validateNode(branch, data, ctx, instancePath, errors)
  }

  if ('const' in schema && data !== schema.const)
    errors.push(`${label}: must equal ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`)

  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(data)))
    errors.push(`${label}: must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(data)}`)

  if (schema.anyOf) {
    const matchesAny = schema.anyOf.some((sub) => {
      const subErrors = []
      validateNode(sub, data, ctx, instancePath, subErrors)
      return subErrors.length === 0
    })
    if (!matchesAny)
      errors.push(`${label}: must match at least one schema in anyOf`)
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(t => matchesType(data, t))) {
      errors.push(`${label}: must be of type ${types.join(' or ')}, got ${typeOf(data)}`)
      return // Further structural checks would be meaningless on the wrong type.
    }
  }

  const type = typeOf(data)

  if (type === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength)
      errors.push(`${label}: length must be >= ${schema.minLength}`)
    if (schema.maxLength !== undefined && data.length > schema.maxLength)
      errors.push(`${label}: length must be <= ${schema.maxLength}`)
    if (schema.pattern && !new RegExp(schema.pattern).test(data))
      errors.push(`${label}: must match pattern ${schema.pattern}, got ${JSON.stringify(data)}`)
    if (schema.format === 'uri') {
      try {
        new URL(data)
      }
      catch {
        errors.push(`${label}: must be a valid URI, got ${JSON.stringify(data)}`)
      }
    }
    if (schema.format === 'date-time' && !DATE_TIME_PATTERN.test(data))
      errors.push(`${label}: must be an RFC 3339 date-time, got ${JSON.stringify(data)}`)
    if (schema.format === 'date' && !isDate(data))
      errors.push(`${label}: must be a YYYY-MM-DD date, got ${JSON.stringify(data)}`)
  }

  if (type === 'number' || type === 'integer') {
    if (schema.minimum !== undefined && data < schema.minimum)
      errors.push(`${label}: must be >= ${schema.minimum}`)
    if (schema.maximum !== undefined && data > schema.maximum)
      errors.push(`${label}: must be <= ${schema.maximum}`)
  }

  if (type === 'array') {
    if (schema.minItems !== undefined && data.length < schema.minItems)
      errors.push(`${label}: must have >= ${schema.minItems} items`)
    if (schema.maxItems !== undefined && data.length > schema.maxItems)
      errors.push(`${label}: must have <= ${schema.maxItems} items`)
    if (schema.uniqueItems) {
      const seen = new Set()
      data.forEach((item, i) => {
        const key = JSON.stringify(item)
        if (seen.has(key))
          errors.push(`${label}[${i}]: duplicate item`)
        seen.add(key)
      })
    }
    if (schema.items) {
      data.forEach((item, i) => {
        validateNode(schema.items, item, ctx, `${instancePath}[${i}]`, errors)
      })
    }
    if (schema.contains !== undefined && !data.some((item, i) => matches(schema.contains, item, ctx, `${instancePath}[${i}]`)))
      errors.push(`${label}: must contain an item matching the schema in contains`)
  }

  if (type === 'object') {
    const keys = Object.keys(data)

    if (schema.minProperties !== undefined && keys.length < schema.minProperties)
      errors.push(`${label}: must have >= ${schema.minProperties} properties`)
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties)
      errors.push(`${label}: must have <= ${schema.maxProperties} properties`)

    if (schema.required) {
      for (const req of schema.required) {
        if (!(req in data))
          errors.push(`${label}: missing required property "${req}"`)
      }
    }

    if (schema.dependentRequired) {
      for (const [key, needed] of Object.entries(schema.dependentRequired)) {
        if (!(key in data))
          continue
        for (const req of needed) {
          if (!(req in data))
            errors.push(`${label}: property "${key}" requires "${req}"`)
        }
      }
    }

    if (schema.propertyNames) {
      for (const key of keys)
        validateNode(schema.propertyNames, key, ctx, `${label} (property name "${key}")`, errors)
    }

    for (const key of keys) {
      if (schema.properties && key in schema.properties) {
        validateNode(schema.properties[key], data[key], ctx, `${instancePath}/${key}`, errors)
        continue
      }
      // Not declared in "properties".
      if (schema.additionalProperties === false) {
        errors.push(`${label}: unexpected property "${key}"`)
      }
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateNode(schema.additionalProperties, data[key], ctx, `${instancePath}/${key}`, errors)
      }
    }
  }
}

/**
 * Validates `data` against the schema at `schemaFile`. Returns an array of
 * human readable error strings; an empty array means `data` is valid.
 */
export function validateAgainstSchemaFile(schemaFile, data) {
  const schema = loadJson(schemaFile)
  const ctx = makeContext(schema, path.dirname(schemaFile))
  const errors = []
  validateNode(schema, data, ctx, '', errors)
  return errors
}
