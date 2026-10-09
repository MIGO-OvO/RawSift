import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('Pass the built Windows Release executable path');
const binary = readFileSync(path);
assert.equal(binary.toString('ascii', 0, 2), 'MZ');
const pe = binary.readUInt32LE(0x3c);
assert.equal(binary.toString('ascii', pe, pe + 4), 'PE\0\0');
const optionalHeader = pe + 24;
const subsystem = binary.readUInt16LE(optionalHeader + 68);
assert.equal(subsystem, 2, 'Release must use Windows GUI subsystem, without an attached console');
console.log('PASS: compiled Windows Release PE uses GUI subsystem (2), not Console (3)');
