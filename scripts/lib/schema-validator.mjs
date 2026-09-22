// A deliberately minimal JSON Schema (draft 2020-12) validator: just the
// subset of keywords schema/*.schema.json actually use. There is no
// dependency on ajv or any other package so `node scripts/validate.mjs` runs
// with nothing but a Node.js installation.
//
// Supported keywords: type, const, enum, anyOf, $ref (local "#/$defs/..."
// and a relative sibling schema file), properties, required,
// additionalProperties (boolean or schema), propertyNames, minProperties,
// maxProperties, items, minItems, maxItems, uniqueItems, minLength,
// maxLength, pattern, minimum, maximum, format ("uri", "date-time").
//
// Anything else (title, description, $schema, $id, ...) is read for
// documentation but never affects validation.

import { readFileSync } from 'node:fs'
import path from 'node:path'

const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

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
  if (ref.startsWith('#/')) {
    const parts = ref.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    let node = ctx.doc
    for (const part of parts) {
      if (node == null || !(part in node))
        throw new Error(`cannot resolve $ref ${ref}: no ${part}`)
      node = node[part]
    }
    return { schema: node, ctx }
  }

  // A relative sibling schema file, e.g. "entry.schema.json".
  const file = path.resolve(ctx.dir, ref)
  if (!ctx.cache.has(file))
    ctx.cache.set(file, loadJson(file))
  const doc = ctx.cache.get(file)
  return { schema: doc, ctx: makeContext(doc, path.dirname(file), ctx.cache) }
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
function validateNode(schema, data, ctx, instancePath, errors) {
  if (typeof schema === 'boolean') {
    if (schema === false)
      errors.push(`${instancePath || '/'}: not allowed here`)
    return
  }

  if (schema.$ref) {
    const { schema: resolved, ctx: nextCtx } = resolveRef(schema.$ref, ctx)
    validateNode(resolved, data, nextCtx, instancePath, errors)
    return
  }

  const label = instancePath || '/'

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

    if (schema.propertyNames) {
      for (const key of keys)
        validateNode(schema.propertyNames, key, ctx, `${label} (property name "${key}")`, errors)
    }

    const declared = schema.properties ? Object.keys(schema.properties) : []
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
    void declared
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
