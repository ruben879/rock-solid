// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planEntryImport, readContacts } from '../src/lib/importer.ts'

const csv = (...lines: string[]) => lines.join('\n')

test('entry import: First Name / Last Name columns (the worked example)', () => {
  const p = planEntryImport(csv('First Name,Last Name,Email,Phone,Street,City,State,Zip', 'Maria,Gonzalez,maria@example.com,8065551234,12 Elm St,Lubbock,TX,79401'), [])
  assert.deepEqual(p.missing, [])
  assert.deepEqual(p.errors, [])
  assert.equal(p.create.length, 1)
  const r = p.create[0]
  assert.equal(`${r.first_name} ${r.last_name}`, 'Maria Gonzalez')
  assert.equal(r.email, 'maria@example.com')
  assert.equal(r.address, '12 Elm St')
  assert.equal(r.city, 'Lubbock')
  assert.equal(r.zip, '79401')
})

test('entry import: first_name / last_name and other underscore headers', () => {
  const p = planEntryImport(csv('first_name,last_name,email,phone,mailing_street_address', 'Maria,Gonzalez,maria@example.com,8065551234,12 Elm St'), [])
  assert.deepEqual(p.missing, [])
  assert.equal(p.create.length, 1)
  assert.equal(`${p.create[0].first_name} ${p.create[0].last_name}`, 'Maria Gonzalez')
  assert.equal(p.create[0].address, '12 Elm St')
})

test('entry import: a row with only a first name (or only a last name) still imports', () => {
  const p = planEntryImport(csv('First Name,Last Name,Email,Phone', 'Maria,,maria@example.com,', ',Gonzalez,,8065551234'), [])
  assert.deepEqual(p.errors, [])
  assert.equal(p.create.length, 2)
  assert.equal(p.create[0].first_name, 'Maria')
  assert.equal(p.create[1].first_name + p.create[1].last_name, 'Gonzalez')
})

test('entry import: a filled Full name cell wins over First and Last', () => {
  const p = planEntryImport(csv('Full name,First,Last,Email,Phone', 'Maria Gonzalez,M,G,maria@example.com,', ',Ana,Diaz,ana@example.com,'), [])
  assert.equal(`${p.create[0].first_name} ${p.create[0].last_name}`, 'Maria Gonzalez')
  assert.equal(`${p.create[1].first_name} ${p.create[1].last_name}`, 'Ana Diaz')
})

test('entry import: name is missing only when there is no full, first or last name column', () => {
  assert.deepEqual(planEntryImport(csv('Email,Phone', 'a@example.com,'), []).missing, ['name'])
  assert.deepEqual(planEntryImport(csv('Last Name,Email,Phone', 'Gonzalez,a@example.com,'), []).missing, [])
  assert.deepEqual(planEntryImport(csv('First Name,Last Name,Phone', 'Maria,Gonzalez,8065551234'), []).missing, ['email'])
})

test('entry import: blank names and rows without email or phone are still error rows', () => {
  const p = planEntryImport(csv('First Name,Last Name,Email,Phone', ',,maria@example.com,', 'Maria,Gonzalez,,'), [])
  assert.deepEqual(p.errors, [2, 3])
  assert.equal(p.create.length, 0)
})

test('entry import: split names still flow through matching (duplicate of an existing contact)', () => {
  const existing = [{ id: 'c1', first_name: 'Maria', last_name: 'Gonzalez', email: 'maria@example.com', phone: null, address: null, city: null, state: null, zip: null }]
  const p = planEntryImport(csv('first_name,last_name,email,phone', 'Maria,Gonzalez,maria@example.com,'), existing)
  assert.equal(p.create.length, 0)
  assert.equal(p.duplicates.length, 1)
})

test('regression, entry import: full_name and Full name files import exactly as before', () => {
  for (const h of ['full_name', 'Full name', 'FULL NAME']) {
    const p = planEntryImport(csv(`${h},email,phone,street,city,state,zip`, 'Maria Gonzalez,maria@example.com,8065551234,12 Elm St,Lubbock,TX,79401'), [])
    assert.deepEqual(p.missing, [])
    assert.equal(p.create.length, 1)
    assert.equal(`${p.create[0].first_name} ${p.create[0].last_name}`, 'Maria Gonzalez')
  }
})

test('main contacts import: first_name / last_name headers (the worked example)', () => {
  const rows = readContacts(csv('first_name,last_name,email,phone', 'Maria,Gonzalez,maria@example.com,8065551234'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].first_name, 'Maria')
  assert.equal(rows[0].last_name, 'Gonzalez')
  assert.equal(rows[0].email, 'maria@example.com')
  assert.equal(rows[0].phone, '806-555-1234')
})

test('main contacts import: full_name header feeds the name split', () => {
  const rows = readContacts(csv('full_name,email_address,cell_phone', 'Maria Gonzalez,maria@example.com,8065551234'))
  assert.equal(rows.length, 1)
  assert.equal(`${rows[0].first_name} ${rows[0].last_name}`, 'Maria Gonzalez')
  assert.equal(rows[0].email, 'maria@example.com')
  assert.equal(rows[0].phone, '806-555-1234')
})

test('regression, main contacts import: spaced and BoldTrail headers import exactly as before', () => {
  const a = readContacts(csv('First Name,Last Name,Email,Cell Phone 1,Birthday,Tier', 'Maria,Gonzalez,Maria@Example.com,8065551234,03/14/1980,A'))
  assert.deepEqual(a, [{ first_name: 'Maria', last_name: 'Gonzalez', phone: '806-555-1234', email: 'maria@example.com', address: null, city: null, state: null, zip: null, tier: 'A', birthday: '1980-03-14', home_anniversary: null }])
  const b = readContacts(csv('Name,Email', 'Maria Gonzalez,maria@example.com'))
  assert.equal(`${b[0].first_name} ${b[0].last_name}`, 'Maria Gonzalez')
})
