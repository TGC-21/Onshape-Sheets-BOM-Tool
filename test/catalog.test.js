import test from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from '../server/lib/partNumber.js'
import { buildSourceKey, contentHash } from '../server/lib/rowIdentity.js'
import { normalizeColumnConfig } from '../server/lib/columnConfig.js'

test('normalizes part numbers consistently', () => assert.equal(normalize('  fr8zz  '), 'FR8ZZ'))
test('builds stable source keys', () => assert.equal(buildSourceKey({ documentId:'d', wvmType:'w', wvmId:'w1', elementId:'e', partIdentity:'p' }), 'd::w::w1::e::p::'))
test('content hashes are deterministic', () => assert.equal(contentHash(['a', 1]), contentHash(['a', 1])))
test('column config rejects duplicate or invalid columns', () => { const result=normalizeColumnConfig([{id:'x',label:'X',source:'user',type:'checkbox'},{id:'x',label:'Duplicate',source:'user',type:'checkbox'},{id:'bad',source:'nope',type:'checkbox'}]); assert.equal(result.length,1); assert.equal(result[0].id,'x') })
