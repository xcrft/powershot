/**
 * Language pack checks, one process per language.
 *
 * They cannot share a process: V8 tiers up each wasm grammar in the background, and
 * eleven of them together drove RSS past 690MB and killed the run. A child per
 * language costs a second and keeps every pack genuinely covered rather than
 * shrinking the suite to fit a limit.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { Project } from 'ts-morph'
import { PACKS, parse, type LanguagePack } from './lang/packs.js'
import type { ChangedFile, ForeignFile, Ground } from './types.js'
import { foreignDroppedGuard, foreignReinvented, tokensFor } from './verifiers/foreign.js'

/** each fixture: a handler that discards, one that genuinely handles, one explained */
const FIXTURES: Record<string, string> = {
  python:
    'def f():\n    try:\n        a()\n    except Exception:\n        pass\n    try:\n        b()\n    except Exception as e:\n        raise RuntimeError("x") from e\n    try:\n        c()\n    except Exception:\n        pass  # deliberate\n',
  go: 'package m\nfunc F() error {\n\tif err := a(); err != nil {\n\t}\n\tif err := b(); err != nil {\n\t\treturn err\n\t}\n\tif err := c(); err != nil {\n\t\t// deliberate\n\t}\n\treturn nil\n}\n',
  java: 'class A {\n  void f() {\n    try { a(); } catch (Exception e) { }\n    try { b(); } catch (Exception e) { throw new RuntimeException(e); }\n    try { c(); } catch (Exception e) { /* deliberate */ }\n  }\n}\n',
  // `let _ = a()` is Rust's own "on purpose" marker and must NOT be reported; the
  // empty Err arm is the one with no such marker
  rust: 'fn f() {\n    let _ = a();\n    match x() { Err(_) => {}, Ok(v) => v };\n    match b() { Err(e) => return Err(e), Ok(v) => v };\n}\n',
  cpp: 'void f() {\n  try { a(); } catch (...) { }\n  try { b(); } catch (const std::exception& e) { throw; }\n  try { c(); } catch (...) { /* deliberate */ }\n}\n',
  c: 'int f(int n) {\n  if (n < 0) { return 0; }\n  return n;\n}\n',
  'c#': 'class A {\n  void F() {\n    try { A(); } catch (Exception e) { }\n    try { B(); } catch (Exception e) { throw; }\n    try { C(); } catch (Exception e) { /* deliberate */ }\n  }\n}\n',
  php: '<?php\nfunction f() {\n  try { a(); } catch (Exception $e) { }\n  try { b(); } catch (Exception $e) { throw $e; }\n  try { c(); } catch (Exception $e) { /* deliberate */ }\n}\n',
  kotlin: 'fun f() {\n  try { a() } catch (e: Exception) {}\n  try { b() } catch (e: Exception) { throw e }\n  try { c() } catch (e: Exception) { /* deliberate */ }\n}\n',
  solidity: 'contract A {\n  function f() public {\n    try a() { } catch { }\n    try b() { } catch { revert("x"); }\n    try c() { } catch { /* deliberate */ }\n  }\n}\n',
  ruby: 'def f\n  begin\n    a\n  rescue => e\n  end\n  begin\n    b\n  rescue => e\n    raise\n  end\n  begin\n    c\n  rescue => e\n    # deliberate\n  end\nend\n',
}

/** the handler in each fixture that genuinely handles, and must never be reported */
const HANDLED: Record<string, string> = {
  python: 'raise RuntimeError', go: 'return err', java: 'throw new RuntimeException',
  rust: 'return Err(e)', cpp: 'throw;', 'c#': 'throw;', php: 'throw $e',
  kotlin: 'throw e', ruby: 'raise', solidity: 'revert("x")',
}

const REINVENTED_NAME: Record<string, [string, string]> = {
  python: ['def f():', 'def normalize_payload():'],
  go: ['func F()', 'func NormalizePayload()'],
  java: ['class A', 'class NormalizePayload'],
  rust: ['fn f()', 'pub fn normalize_payload()'],
  cpp: ['void f()', 'void normalizePayload()'],
  c: ['int f(', 'int normalizePayload('],
  'c#': ['class A', 'class NormalizePayload'],
  php: ['function f()', 'function normalizePayload()'],
  kotlin: ['fun f()', 'fun normalizePayload()'],
  ruby: ['def f\n', 'def normalize_payload\n'],
  solidity: ['contract A', 'contract NormalizePayload'],
}

const REINVENTED_MUTATION: Record<string, [string, string]> = {
  python: ['a()', 'z()'],
  go: ['a()', 'z()'],
  java: ['a()', 'z()'],
  rust: ['a()', 'z()'],
  cpp: ['a()', 'z()'],
  c: ['return n;', 'return n + 1;'],
  'c#': ['A()', 'Z()'],
  php: ['a()', 'z()'],
  kotlin: ['a()', 'z()'],
  ruby: ['    a\n', '    z\n'],
  solidity: ['a()', 'z()'],
}

const NESTED_REINVENTION: Partial<Record<string, [string, string]>> = {
  python: [
    'class Primary:\n    def normalize_payload(self):\n        return True\n',
    'class Recording:\n    def normalize_payload(self):\n        return True\n',
  ],
  go: [
    'package sample\ntype Primary struct{}\nfunc (Primary) NormalizePayload() bool { return true }\n',
    'package sample\ntype Recording struct{}\nfunc (Recording) NormalizePayload() bool { return true }\n',
  ],
  java: [
    'class Primary { boolean normalizePayload() { return true; } }\n',
    'class Recording { boolean normalizePayload() { return true; } }\n',
  ],
  cpp: [
    'struct Primary { bool normalizePayload() { return true; } };\n',
    'struct Recording { bool normalizePayload() { return true; } };\n',
  ],
  'c#': [
    'class Primary { bool NormalizePayload() { return true; } }\n',
    'class Recording { bool NormalizePayload() { return true; } }\n',
  ],
  php: [
    '<?php class Primary { function normalizePayload() { return true; } }\n',
    '<?php class Recording { function normalizePayload() { return true; } }\n',
  ],
  kotlin: [
    'class Primary { fun normalizePayload(): Boolean = true }\n',
    'class Recording { fun normalizePayload(): Boolean = true }\n',
  ],
  ruby: [
    'class Primary\n  def normalize_payload\n    true\n  end\nend\n',
    'class Recording\n  def normalize_payload\n    true\n  end\nend\n',
  ],
  solidity: [
    'contract Primary { function normalizePayload() public pure returns (bool) { return true; } }\n',
    'contract Recording { function normalizePayload() public pure returns (bool) { return true; } }\n',
  ],
}

const WRAPPED_REINVENTION: Partial<Record<string, {
  same: string
  differentScope?: string
  differentWrapper?: string
}>> = {
  python: {
    same: '@portable\ndef normalize_payload():\n    return True\n',
    differentWrapper: '@separate\ndef normalize_payload():\n    return True\n',
  },
  cpp: {
    same: [
      'namespace portable {',
      'template <typename T>',
      'T normalizePayload(T value) { return value; }',
      '}',
      '',
    ].join('\n'),
    differentScope: [
      'namespace separate {',
      'template <typename T>',
      'T normalizePayload(T value) { return value; }',
      '}',
      '',
    ].join('\n'),
    differentWrapper: [
      'namespace portable {',
      'template <typename T, typename U>',
      'T normalizePayload(T value) { return value; }',
      '}',
      '',
    ].join('\n'),
  },
  'c#': {
    same: 'namespace Portable.Sample { class NormalizePayload { bool Run() { return true; } } }\n',
    differentScope: 'namespace portable.Sample { class NormalizePayload { bool Run() { return true; } } }\n',
  },
  php: {
    same: '<?php namespace Portable\\Sample { function normalizePayload() { return true; } }\n',
    differentScope: '<?php namespace Separate\\Sample { function normalizePayload() { return true; } }\n',
  },
}

const FILE_PRIVATE_REINVENTION: Partial<Record<string, string>> = {
  rust: '#[inline]\nfn normalize_payload() -> bool { true }\n',
  cpp: '[[maybe_unused]] static int normalizePayload(int value) { return value; }\n',
  c: 'static int normalizePayload(int value) { return value; }\n',
  kotlin: '@Deprecated("fixture")\nprivate fun normalizePayload(): Boolean = true\n',
}

const BINDING_CONTEXT_REINVENTION: Record<string, { same: string; different: string }> = {
  python: {
    same: 'from alpha import Tools\ndef normalize_payload(value):\n    return value\n',
    different: 'from beta import Tools\ndef normalize_payload(value):\n    return value\n',
  },
  go: {
    same: 'package sample\nimport _ "alpha"\nfunc NormalizePayload(value int) int { return value }\n',
    different: 'package sample\nimport _ "beta"\nfunc NormalizePayload(value int) int { return value }\n',
  },
  java: {
    same: 'import alpha.Tools;\nclass NormalizePayload { boolean run() { return true; } }\n',
    different: 'import beta.Tools;\nclass NormalizePayload { boolean run() { return true; } }\n',
  },
  rust: {
    same: 'use alpha::Tools;\npub fn normalize_payload() -> bool { true }\n',
    different: 'use beta::Tools;\npub fn normalize_payload() -> bool { true }\n',
  },
  cpp: {
    same: '#include "alpha.h"\nint normalizePayload(int value) { return value; }\n',
    different: '#include "beta.h"\nint normalizePayload(int value) { return value; }\n',
  },
  c: {
    same: '#include "alpha.h"\nint normalizePayload(int value) { return value; }\n',
    different: '#include "beta.h"\nint normalizePayload(int value) { return value; }\n',
  },
  'c#': {
    same: 'using Alpha;\nclass NormalizePayload { bool Run() { return true; } }\n',
    different: 'using Beta;\nclass NormalizePayload { bool Run() { return true; } }\n',
  },
  php: {
    same: '<?php use Alpha\\Tools;\nfunction normalizePayload($value) { return $value; }\n',
    different: '<?php use Beta\\Tools;\nfunction normalizePayload($value) { return $value; }\n',
  },
  kotlin: {
    same: 'import alpha.Tools\nfun normalizePayload(value: Int): Int = value\n',
    different: 'import beta.Tools\nfun normalizePayload(value: Int): Int = value\n',
  },
  ruby: {
    same: 'require "alpha"\ndef normalize_payload(value)\n  value\nend\n',
    different: 'require "beta"\ndef normalize_payload(value)\n  value\nend\n',
  },
  solidity: {
    same: 'import "./alpha.sol";\nfunction normalizePayload(uint value) pure returns (uint) { return value; }\n',
    different: 'import "./beta.sol";\nfunction normalizePayload(uint value) pure returns (uint) { return value; }\n',
  },
}

const MODULE_BINDING_REINVENTION: Partial<Record<string, { same: string; different: string }>> = {
  python: {
    same: 'SCALE = 2\ndef normalize_payload(value):\n    return value * SCALE\n',
    different: 'SCALE = 3\ndef normalize_payload(value):\n    return value * SCALE\n',
  },
  go: {
    same: 'package sample\nconst SCALE = 2\nfunc NormalizePayload(value int) int { return value * SCALE }\n',
    different: 'package sample\nconst SCALE = 3\nfunc NormalizePayload(value int) int { return value * SCALE }\n',
  },
  rust: {
    same: 'const SCALE: i32 = 2;\npub fn normalize_payload(value: i32) -> i32 { value * SCALE }\n',
    different: 'const SCALE: i32 = 3;\npub fn normalize_payload(value: i32) -> i32 { value * SCALE }\n',
  },
  cpp: {
    same: 'const int SCALE = 2;\nint normalizePayload(int value) { return value * SCALE; }\n',
    different: 'const int SCALE = 3;\nint normalizePayload(int value) { return value * SCALE; }\n',
  },
  c: {
    same: 'const int SCALE = 2;\nint normalizePayload(int value) { return value * SCALE; }\n',
    different: 'const int SCALE = 3;\nint normalizePayload(int value) { return value * SCALE; }\n',
  },
  php: {
    same: '<?php const SCALE = 2;\nfunction normalizePayload($value) { return $value * SCALE; }\n',
    different: '<?php const SCALE = 3;\nfunction normalizePayload($value) { return $value * SCALE; }\n',
  },
  kotlin: {
    same: 'const val SCALE = 2\nfun normalizePayload(value: Int): Int = value * SCALE\n',
    different: 'const val SCALE = 3\nfun normalizePayload(value: Int): Int = value * SCALE\n',
  },
  ruby: {
    same: 'SCALE = 2\ndef normalize_payload(value)\n  value * SCALE\nend\n',
    different: 'SCALE = 3\ndef normalize_payload(value)\n  value * SCALE\nend\n',
  },
  solidity: {
    same: 'uint constant SCALE = 2;\nfunction normalizePayload(uint value) pure returns (uint) { return value * SCALE; }\n',
    different: 'uint constant SCALE = 3;\nfunction normalizePayload(uint value) pure returns (uint) { return value * SCALE; }\n',
  },
}

const TYPE_BINDING_REINVENTION: Partial<Record<string, { same: string; different: string }>> = {
  go: {
    same: 'package sample\ntype Payload = int\nfunc NormalizePayload(value Payload) Payload { return value }\n',
    different: 'package sample\ntype Payload = string\nfunc NormalizePayload(value Payload) Payload { return value }\n',
  },
  rust: {
    same: 'type Payload = i32;\npub fn normalize_payload(value: Payload) -> Payload { value }\n',
    different: 'type Payload = i64;\npub fn normalize_payload(value: Payload) -> Payload { value }\n',
  },
  cpp: {
    same: 'using Payload = int;\nPayload normalizePayload(Payload value) { return value; }\n',
    different: 'using Payload = long;\nPayload normalizePayload(Payload value) { return value; }\n',
  },
  c: {
    same: 'typedef int Payload;\nPayload normalizePayload(Payload value) { return value; }\n',
    different: 'typedef long Payload;\nPayload normalizePayload(Payload value) { return value; }\n',
  },
  kotlin: {
    same: 'typealias Payload = Int\nfun normalizePayload(value: Payload): Payload = value\n',
    different: 'typealias Payload = Long\nfun normalizePayload(value: Payload): Payload = value\n',
  },
}

const RELATIVE_BINDING_REINVENTION: Partial<Record<string, string>> = {
  python: 'from .tools import transform\ndef normalize_payload(value):\n    return transform(value)\n',
  rust: 'use super::tools::transform;\npub fn normalize_payload(value: i32) -> i32 { transform(value) }\n',
  cpp: '#include "tools.h"\nint normalizePayload(int value) { return transform(value); }\n',
  c: '#include "tools.h"\nint normalizePayload(int value) { return transform(value); }\n',
  ruby: 'require_relative "tools"\ndef normalize_payload(value)\n  transform(value)\nend\n',
  solidity: 'import "./tools.sol";\nfunction normalizePayload(uint value) pure returns (uint) { return transform(value); }\n',
}

type GuardCase = { before: string; guard: string; extracted: string }

const GUARD_CONTRACT_MUTATION: Record<string, [string, string]> = {
  python: ['def release(slot):', 'def release(slot: object):'],
  go: ['func Release(slot Slot) bool', 'func Release(slot *Slot) bool'],
  java: ['static boolean release(Slot slot)', 'static boolean release(Object slot)'],
  rust: ['fn sweep(slot: &Slot) -> bool', 'fn sweep(slot: Slot) -> bool'],
  cpp: ['bool release(Slot& slot)', 'bool release(const Slot& slot)'],
  c: ['int release(Slot *slot)', 'int release(const Slot *slot)'],
  'c#': ['static bool Release(Slot slot)', 'static bool Release(object slot)'],
  php: ['function release($slot)', 'function release(object $slot)'],
  kotlin: ['fun release(slot: Slot): Boolean', 'fun release(slot: Slot?): Boolean'],
  ruby: ['def release(slot)', 'def release(slot, force = false)'],
  solidity: [
    'function release(Slot slot) public returns (bool)',
    'function release(Slot slot, bool force) public returns (bool)',
  ],
}

const OWNER_GUARDS: Partial<Record<string, { before: string; guard: string }>> = {
  python: {
    before: 'class Primary:\n    def release(self, slot):\n        if slot is None: return False\n        return True\n',
    guard: '        if slot is None: return False\n',
  },
  go: {
    before: 'package sample\ntype Primary struct{}\nfunc (Primary) Release(slot *int) bool {\n\tif slot == nil { return false }\n\treturn true\n}\n',
    guard: '\tif slot == nil { return false }\n',
  },
  java: {
    before: 'class Primary { boolean release(Object slot) {\n  if (slot == null) return false;\n  return true;\n} }\n',
    guard: '  if (slot == null) return false;\n',
  },
  rust: {
    before: 'struct Primary;\nimpl Primary { fn release(&self, slot: Option<u8>) -> bool {\n  if slot.is_none() { return false; }\n  true\n} }\n',
    guard: '  if slot.is_none() { return false; }\n',
  },
  cpp: {
    before: 'struct Primary { bool release(void* slot) {\n  if (slot == nullptr) return false;\n  return true;\n} };\n',
    guard: '  if (slot == nullptr) return false;\n',
  },
  'c#': {
    before: 'class Primary { bool Release(object slot) {\n  if (slot == null) return false;\n  return true;\n} }\n',
    guard: '  if (slot == null) return false;\n',
  },
  php: {
    before: '<?php class Primary { function release($slot) {\n  if ($slot === null) return false;\n  return true;\n} }\n',
    guard: '  if ($slot === null) return false;\n',
  },
  kotlin: {
    before: 'class Primary { fun release(slot: Any?): Boolean {\n  if (slot == null) return false\n  return true\n} }\n',
    guard: '  if (slot == null) return false\n',
  },
  ruby: {
    before: 'class Primary\n  def release(slot)\n    return false if slot.nil?\n    true\n  end\nend\n',
    guard: '    return false if slot.nil?\n',
  },
  solidity: {
    before: 'contract Primary { function release(address slot) public returns (bool) {\n  if (slot == address(0)) return false;\n  return true;\n} }\n',
    guard: '  if (slot == address(0)) return false;\n',
  },
}

const GUARD_CASES: Record<string, GuardCase> = {
  python: {
    before: [
      'def ready(slot): return True',
      'def close_slot(slot): return True',
      'def release(slot):',
      '    if not ready(slot):',
      '        return False',
      '    return close_slot(slot)',
      '',
    ].join('\n'),
    guard: '    if not ready(slot):\n        return False\n',
    extracted: [
      'def ready(slot): return True',
      'def close_slot(slot): return True',
      'def close_if_ready(slot):',
      '    if not ready(slot):',
      '        return False',
      '    return close_slot(slot)',
      'def release(slot):',
      '    return close_if_ready(slot)',
      '',
    ].join('\n'),
  },
  go: {
    before: [
      'package sample',
      'type Slot struct{}',
      'func (Slot) Ready() bool { return true }',
      'func (Slot) Close() bool { return true }',
      'func Release(slot Slot) bool {',
      '\tif !slot.Ready() { return false }',
      '\treturn slot.Close()',
      '}',
      '',
    ].join('\n'),
    guard: '\tif !slot.Ready() { return false }\n',
    extracted: [
      'package sample',
      'type Slot struct{}',
      'func (Slot) Ready() bool { return true }',
      'func (Slot) Close() bool { return true }',
      'func closeIfReady(slot Slot) bool {',
      '\tif !slot.Ready() { return false }',
      '\treturn slot.Close()',
      '}',
      'func Release(slot Slot) bool { return closeIfReady(slot) }',
      '',
    ].join('\n'),
  },
  java: {
    before: [
      'class Slot {',
      '  boolean ready() { return true; }',
      '  boolean close() { return true; }',
      '}',
      'class Runner {',
      '  static boolean release(Slot slot) {',
      '    if (!slot.ready()) { return false; }',
      '    return slot.close();',
      '  }',
      '}',
      '',
    ].join('\n'),
    guard: '    if (!slot.ready()) { return false; }\n',
    extracted: [
      'class Slot {',
      '  boolean ready() { return true; }',
      '  boolean close() { return true; }',
      '}',
      'class Runner {',
      '  static boolean closeIfReady(Slot slot) {',
      '    if (!slot.ready()) { return false; }',
      '    return slot.close();',
      '  }',
      '  static boolean release(Slot slot) { return closeIfReady(slot); }',
      '}',
      '',
    ].join('\n'),
  },
  rust: {
    before: [
      'struct Slot;',
      'impl Slot {',
      '    fn is_ready(&self) -> bool { true }',
      '    fn close(&self) -> bool { true }',
      '}',
      'fn sweep(slot: &Slot) -> bool {',
      '    if !slot.is_ready() { return false; }',
      '    slot.close()',
      '}',
      '',
    ].join('\n'),
    guard: '    if !slot.is_ready() { return false; }\n',
    extracted: [
      'struct Slot;',
      'impl Slot {',
      '    fn is_ready(&self) -> bool { true }',
      '    fn close(&self) -> bool { true }',
      '    fn close_if_ready(&self) -> bool {',
      '        if !self.is_ready() { return false; }',
      '        self.close()',
      '    }',
      '}',
      'fn sweep(slot: &Slot) -> bool {',
      '    slot.close_if_ready()',
      '}',
      '',
    ].join('\n'),
  },
  cpp: {
    before: [
      'struct Slot { bool ready(); bool close(); };',
      'bool release(Slot& slot) {',
      '  if (!slot.ready()) { return false; }',
      '  return slot.close();',
      '}',
      '',
    ].join('\n'),
    guard: '  if (!slot.ready()) { return false; }\n',
    extracted: [
      'struct Slot { bool ready(); bool close(); };',
      'bool closeIfReady(Slot& slot) {',
      '  if (!slot.ready()) { return false; }',
      '  return slot.close();',
      '}',
      'bool release(Slot& slot) { return closeIfReady(slot); }',
      '',
    ].join('\n'),
  },
  c: {
    before: [
      'typedef struct Slot Slot;',
      'int slot_ready(Slot *slot) { return 1; }',
      'int slot_close(Slot *slot) { return 1; }',
      'int release(Slot *slot) {',
      '  if (!slot_ready(slot)) { return 0; }',
      '  return slot_close(slot);',
      '}',
      '',
    ].join('\n'),
    guard: '  if (!slot_ready(slot)) { return 0; }\n',
    extracted: [
      'typedef struct Slot Slot;',
      'int slot_ready(Slot *slot) { return 1; }',
      'int slot_close(Slot *slot) { return 1; }',
      'int close_if_ready(Slot *slot) {',
      '  if (!slot_ready(slot)) { return 0; }',
      '  return slot_close(slot);',
      '}',
      'int release(Slot *slot) { return close_if_ready(slot); }',
      '',
    ].join('\n'),
  },
  'c#': {
    before: [
      'class Slot {',
      '  public bool Ready() { return true; }',
      '  public bool Close() { return true; }',
      '}',
      'class Runner {',
      '  static bool Release(Slot slot) {',
      '    if (!slot.Ready()) { return false; }',
      '    return slot.Close();',
      '  }',
      '}',
      '',
    ].join('\n'),
    guard: '    if (!slot.Ready()) { return false; }\n',
    extracted: [
      'class Slot {',
      '  public bool Ready() { return true; }',
      '  public bool Close() { return true; }',
      '}',
      'class Runner {',
      '  static bool CloseIfReady(Slot slot) {',
      '    if (!slot.Ready()) { return false; }',
      '    return slot.Close();',
      '  }',
      '  static bool Release(Slot slot) { return CloseIfReady(slot); }',
      '}',
      '',
    ].join('\n'),
  },
  php: {
    before: [
      '<?php',
      'function ready($slot) { return true; }',
      'function close_slot($slot) { return true; }',
      'function release($slot) {',
      '  if (!ready($slot)) { return false; }',
      '  return close_slot($slot);',
      '}',
      '',
    ].join('\n'),
    guard: '  if (!ready($slot)) { return false; }\n',
    extracted: [
      '<?php',
      'function ready($slot) { return true; }',
      'function close_slot($slot) { return true; }',
      'function close_if_ready($slot) {',
      '  if (!ready($slot)) { return false; }',
      '  return close_slot($slot);',
      '}',
      'function release($slot) { return close_if_ready($slot); }',
      '',
    ].join('\n'),
  },
  kotlin: {
    before: [
      'class Slot {',
      '  fun ready(): Boolean = true',
      '  fun close(): Boolean = true',
      '}',
      'fun release(slot: Slot): Boolean {',
      '  if (!slot.ready()) return false',
      '  return slot.close()',
      '}',
      '',
    ].join('\n'),
    guard: '  if (!slot.ready()) return false\n',
    extracted: [
      'class Slot {',
      '  fun ready(): Boolean = true',
      '  fun close(): Boolean = true',
      '}',
      'fun closeIfReady(slot: Slot): Boolean {',
      '  if (!slot.ready()) return false',
      '  return slot.close()',
      '}',
      'fun release(slot: Slot): Boolean = closeIfReady(slot)',
      '',
    ].join('\n'),
  },
  ruby: {
    before: [
      'def ready(slot)',
      '  true',
      'end',
      'def close_slot(slot)',
      '  true',
      'end',
      'def release(slot)',
      '  if !ready(slot)',
      '    return false',
      '  end',
      '  close_slot(slot)',
      'end',
      '',
    ].join('\n'),
    guard: '  if !ready(slot)\n    return false\n  end\n',
    extracted: [
      'def ready(slot)',
      '  true',
      'end',
      'def close_slot(slot)',
      '  true',
      'end',
      'def close_if_ready(slot)',
      '  if !ready(slot)',
      '    return false',
      '  end',
      '  close_slot(slot)',
      'end',
      'def release(slot)',
      '  close_if_ready(slot)',
      'end',
      '',
    ].join('\n'),
  },
  solidity: {
    before: [
      'contract Slot {',
      '  function ready() public pure returns (bool) { return true; }',
      '  function close() public pure returns (bool) { return true; }',
      '}',
      'contract Runner {',
      '  function release(Slot slot) public returns (bool) {',
      '    if (!slot.ready()) { return false; }',
      '    return slot.close();',
      '  }',
      '}',
      '',
    ].join('\n'),
    guard: '    if (!slot.ready()) { return false; }\n',
    extracted: [
      'contract Slot {',
      '  function ready() public pure returns (bool) { return true; }',
      '  function close() public pure returns (bool) { return true; }',
      '}',
      'contract Runner {',
      '  function closeIfReady(Slot slot) internal returns (bool) {',
      '    if (!slot.ready()) { return false; }',
      '    return slot.close();',
      '  }',
      '  function release(Slot slot) public returns (bool) { return closeIfReady(slot); }',
      '}',
      '',
    ].join('\n'),
  },
}

const GUARD_ABSORPTION: Record<string, [string, string]> = {
  python: [
    'def close_slot(slot): return True',
    'def close_slot(slot):\n    if not ready(slot):\n        return False\n    return True',
  ],
  go: [
    'func (Slot) Close() bool { return true }',
    'func (slot Slot) Close() bool { if !slot.Ready() { return false }; return true }',
  ],
  java: [
    '  boolean close() { return true; }',
    '  boolean close() { if (!ready()) { return false; } return true; }',
  ],
  rust: [
    '    fn close(&self) -> bool { true }',
    '    fn close(&self) -> bool { if !self.is_ready() { return false; } true }',
  ],
  cpp: [
    'struct Slot { bool ready(); bool close(); };',
    'struct Slot { bool ready(); bool close() { if (!ready()) { return false; } return true; } };',
  ],
  c: [
    'int slot_close(Slot *slot) { return 1; }',
    'int slot_close(Slot *slot) { if (!slot_ready(slot)) { return 0; } return 1; }',
  ],
  'c#': [
    '  public bool Close() { return true; }',
    '  public bool Close() { if (!Ready()) { return false; } return true; }',
  ],
  php: [
    'function close_slot($slot) { return true; }',
    'function close_slot($slot) { if (!ready($slot)) { return false; } return true; }',
  ],
  kotlin: [
    '  fun close(): Boolean = true',
    '  fun close(): Boolean { if (!ready()) return false; return true }',
  ],
  ruby: [
    'def close_slot(slot)\n  true\nend',
    'def close_slot(slot)\n  return false if !ready(slot)\n  true\nend',
  ],
  solidity: [
    '  function close() public pure returns (bool) { return true; }',
    '  function close() public pure returns (bool) { if (!ready()) { return false; } return true; }',
  ],
}

function allLines(source: string): Set<number> {
  return new Set(Array.from({ length: source.split('\n').length }, (_, index) => index + 1))
}

function withFileScope(language: string, source: string, scope: string): string {
  if (language === 'go') return source.replace(/^package\s+\w+/m, 'package ' + scope)
  if (language === 'java') return 'package ' + scope + ';\n' + source
  if (language === 'kotlin') return 'package ' + scope + '\n' + source
  return source
}

async function foreignReinventionGround(
  pack: LanguagePack,
  existingSource: string,
  addedSource: string,
  existingBeforeSource: string | null = existingSource,
  addedBeforeSource?: string,
  paths?: { existing: string; added: string },
): Promise<Ground> {
  const extension = pack.extensions[0]!
  const existingPath = paths?.existing ?? 'z-existing' + extension
  const addedPath = paths?.added ?? 'a-new' + extension
  const existingTree = await parse(pack, existingSource)
  const addedTree = await parse(pack, addedSource)
  const beforeTree = existingBeforeSource === null ? undefined : await parse(pack, existingBeforeSource)
  const addedBeforeTree = addedBeforeSource === undefined ? undefined : await parse(pack, addedBeforeSource)
  if (!existingTree || !addedTree) throw new Error('fixture did not parse')

  const existingChange: ChangedFile = {
    path: existingPath,
    added: existingBeforeSource === null ? allLines(existingSource) : new Set(),
    before: existingBeforeSource ?? undefined,
  }
  const addedChange: ChangedFile = { path: addedPath, added: allLines(addedSource), before: addedBeforeSource }
  const foreign: ForeignFile[] = [
    { path: existingPath, pack, tree: existingTree, beforeTree, changed: existingChange },
    { path: addedPath, pack, tree: addedTree, beforeTree: addedBeforeTree, changed: addedChange },
  ]
  return {
    root: '/virtual/repo',
    sourceFiles: [],
    configFiles: [],
    beforeProject: new Project({ useInMemoryFileSystem: true }),
    changed: [existingChange, addedChange],
    files: [],
    symbolIndex: new Map(),
    deps: new Set(),
    depsFor: () => new Set(),
    typed: false,
    internalPrefixes: [],
    foreign,
  }
}

async function foreignReinventionPair(
  pack: LanguagePack,
  source: string,
  variant: string,
): Promise<{ control: Ground; variant: Ground }> {
  return {
    control: await foreignReinventionGround(pack, source, source),
    variant: await foreignReinventionGround(pack, source, variant),
  }
}

async function foreignGuardGround(
  pack: LanguagePack,
  before: string,
  after: string,
  other?: { path: string; before: string; after: string },
): Promise<Ground> {
  const path = 'src/release' + pack.extensions[0]!
  const tree = await parse(pack, after)
  const beforeTree = await parse(pack, before)
  if (!tree || !beforeTree) throw new Error('guard fixture did not parse')
  const changed: ChangedFile = { path, added: allLines(after), before }
  const changes = [changed]
  const foreign: ForeignFile[] = [{ path, pack, tree, beforeTree, changed }]
  if (other) {
    const otherTree = await parse(pack, other.after)
    const otherBeforeTree = await parse(pack, other.before)
    if (!otherTree || !otherBeforeTree) throw new Error('secondary guard fixture did not parse')
    const otherChange: ChangedFile = {
      path: other.path,
      added: allLines(other.after),
      before: other.before,
    }
    changes.push(otherChange)
    foreign.push({
      path: other.path,
      pack,
      tree: otherTree,
      beforeTree: otherBeforeTree,
      changed: otherChange,
    })
  }
  return {
    root: '/virtual/repo',
    sourceFiles: [],
    configFiles: [],
    beforeProject: new Project({ useInMemoryFileSystem: true }),
    changed: changes,
    files: [],
    symbolIndex: new Map(),
    deps: new Set(),
    depsFor: () => new Set(),
    typed: false,
    internalPrefixes: [],
    foreign,
  }
}

async function rustTraitMethodGround(pack: LanguagePack): Promise<Ground> {
  const existing = [
    'trait Source { fn access_mode(&self) -> bool; }',
    'struct Primary;',
    'impl Source for Primary {',
    '    fn access_mode(&self) -> bool { true }',
    '}',
    '',
  ].join('\n')
  const added = [
    '#[cfg(test)]',
    'mod support {',
    '    use super::Source;',
    '    struct Recording;',
    '    impl Source for Recording {',
    '        fn access_mode(&self) -> bool { true }',
    '    }',
    '}',
    '',
  ].join('\n')
  return foreignReinventionGround(pack, existing, added)
}

async function one(name: string): Promise<number> {
  const pack = PACKS.find((p) => p.name === name)
  if (!pack) {
    console.error('no pack named ' + name)
    return 1
  }
  let failed = 0
  const check = (label: string, fn: () => void): void => {
    try {
      fn()
      console.log('  ok   ' + name + ': ' + label)
    } catch (e) {
      failed++
      console.log('  FAIL ' + name + ': ' + label + '\n       ' + (e as Error).message)
    }
  }

  const source = FIXTURES[name]
  const tree = source === undefined ? undefined : await parse(pack, source)

  check('has a fixture, so it is never asserted against another language', () => {
    assert.ok(source !== undefined, 'no fixture written')
  })
  check('the grammar loads and parses', () => {
    assert.ok(tree, 'failed to parse — grammar missing or ABI mismatch')
  })
  check('declares the node names the generic checks need', () => {
    for (const key of [
      'identifier', 'comment', 'ifStatement', 'bail', 'declaration',
      'callable', 'callableBody', 'reusableDeclaration', 'block',
    ] as const) {
      assert.ok((pack.nodes[key] as string[]).length > 0, 'no ' + key)
    }
    if (pack.nodes.callableOwner.length > 0) {
      assert.ok(pack.nodes.callableOwnerBody.length > 0, 'callable owners have no body vocabulary')
    }
  })

  const hits = tree ? pack.swallowedError?.(tree.rootNode) ?? [] : []
  if (name === 'c') {
    check('does not advertise an exception oracle the language cannot supply', () => {
      assert.equal(pack.swallowedError, undefined)
    })
  } else {
    check('finds the idiom that discards a failure', () => {
      assert.ok(hits.length >= 1, 'found none')
    })
    check('stays silent where a comment states the intent', () => {
      assert.equal(hits.some((h) => /deliberate/.test(h.node.text)), false, 'reported an explained handler')
    })
    check('leaves a properly handled error alone', () => {
      assert.equal(hits.some((h) => h.node.text.includes(HANDLED[name]!)), false, 'reported a real handler')
    })
  }

  if (source && tree) {
    const rename = REINVENTED_NAME[name]
    const mutation = REINVENTED_MUTATION[name]
    assert.ok(rename && mutation, 'no reinvention fixture written')
    const existing = source.replace(rename[0], rename[1])
    const different = existing.replace(mutation[0], mutation[1])
    const differentGround = await foreignReinventionGround(pack, existing, different)
    const identicalGround = await foreignReinventionGround(pack, existing, existing)
    const bothNewGround = await foreignReinventionGround(pack, existing, existing, null)
    const candidateChangedGround = await foreignReinventionGround(pack, existing, existing, different)
    const targetPreexistingGround = await foreignReinventionGround(pack, existing, existing, existing, existing)

    check('reinvented ignores a same-name different implementation', () => {
      assert.equal(foreignReinvented.run(differentGround).length, 0)
    })
    check('reinvented detects an exact implementation already present in the base', () => {
      assert.ok(foreignReinvented.run(identicalGround).length >= 1)
    })
    check('reinvented does not compare two declarations both added by the change', () => {
      assert.equal(foreignReinvented.run(bothNewGround).length, 0)
    })
    check('reinvented ignores a candidate that only became equivalent in this change', () => {
      assert.equal(foreignReinvented.run(candidateChangedGround).length, 0)
    })
    check('reinvented ignores an implementation already present in the changed file', () => {
      assert.equal(foreignReinvented.run(targetPreexistingGround).length, 0)
    })
    const bindingContext = BINDING_CONTEXT_REINVENTION[name]!
    const bindingContextGrounds = await foreignReinventionPair(
      pack,
      bindingContext.same,
      bindingContext.different,
    )
    check('reinvented preserves an exact binding context control', () => {
      assert.ok(foreignReinvented.run(bindingContextGrounds.control).length >= 1)
    })
    check('reinvented keeps different import and directive bindings separate', () => {
      assert.equal(foreignReinvented.run(bindingContextGrounds.variant).length, 0)
    })

    const moduleBinding = MODULE_BINDING_REINVENTION[name]
    if (moduleBinding) {
      const sameModuleBindingGround = await foreignReinventionGround(pack, moduleBinding.same, moduleBinding.same)
      const differentModuleBindingGround = await foreignReinventionGround(
        pack,
        moduleBinding.same,
        moduleBinding.different,
      )
      check('reinvented preserves an exact referenced module binding control', () => {
        assert.ok(foreignReinvented.run(sameModuleBindingGround).length >= 1)
      })
      check('reinvented keeps different referenced module bindings separate', () => {
        assert.equal(foreignReinvented.run(differentModuleBindingGround).length, 0)
      })
    }

    const typeBinding = TYPE_BINDING_REINVENTION[name]
    if (typeBinding) {
      const sameTypeBindingGround = await foreignReinventionGround(pack, typeBinding.same, typeBinding.same)
      const differentTypeBindingGround = await foreignReinventionGround(
        pack,
        typeBinding.same,
        typeBinding.different,
      )
      check('reinvented preserves an exact referenced type binding control', () => {
        assert.ok(foreignReinvented.run(sameTypeBindingGround).length >= 1)
      })
      check('reinvented keeps different referenced type bindings separate', () => {
        assert.equal(foreignReinvented.run(differentTypeBindingGround).length, 0)
      })
    }

    const relativeBinding = RELATIVE_BINDING_REINVENTION[name]
    if (relativeBinding) {
      const extension = pack.extensions[0]!
      const sameDirectoryGround = await foreignReinventionGround(
        pack,
        relativeBinding,
        relativeBinding,
        relativeBinding,
        undefined,
        { existing: 'alpha/existing' + extension, added: 'alpha/added' + extension },
      )
      const differentDirectoryGround = await foreignReinventionGround(
        pack,
        relativeBinding,
        relativeBinding,
        relativeBinding,
        undefined,
        { existing: 'alpha/existing' + extension, added: 'beta/added' + extension },
      )
      check('reinvented preserves a same-directory relative binding control', () => {
        assert.ok(foreignReinvented.run(sameDirectoryGround).length >= 1)
      })
      check('reinvented qualifies relative bindings by source directory', () => {
        assert.equal(foreignReinvented.run(differentDirectoryGround).length, 0)
      })
    }
    if (name === 'go' || name === 'java' || name === 'kotlin') {
      const scopedGround = async (existingScope: string, addedScope: string): Promise<Ground> =>
        foreignReinventionGround(
          pack,
          withFileScope(name, existing, existingScope),
          withFileScope(name, existing, addedScope),
        )
      const sameScopeGround = await scopedGround('alpha', 'alpha')
      const otherScopeGround = await scopedGround('alpha', 'beta')
      check('reinvented detects an exact declaration in the same language package', () => {
        assert.ok(foreignReinvented.run(sameScopeGround).length >= 1)
      })
      check('reinvented keeps language packages separate', () => {
        assert.equal(foreignReinvented.run(otherScopeGround).length, 0)
      })
    }
    if (name === 'go') {
      const scoped = withFileScope(name, existing, 'sample')
      const directoryGround = await foreignReinventionGround(
        pack,
        scoped,
        scoped,
        scoped,
        undefined,
        { existing: 'first/existing.go', added: 'second/added.go' },
      )
      check('reinvented keeps distinct Go import paths separate', () => {
        assert.equal(foreignReinvented.run(directoryGround).length, 0)
      })
    }
    const filePrivate = FILE_PRIVATE_REINVENTION[name]
    if (filePrivate) {
      const privateGround = await foreignReinventionGround(pack, filePrivate, filePrivate)
      check('reinvented ignores declarations unavailable across files', () => {
        assert.equal(foreignReinvented.run(privateGround).length, 0)
      })
    }
    if (name === 'cpp') {
      const anonymous = 'namespace { bool normalizePayload() { return true; } }\n'
      const anonymousGround = await foreignReinventionGround(pack, anonymous, anonymous)
      check('reinvented ignores declarations in anonymous namespaces', () => {
        assert.equal(foreignReinvented.run(anonymousGround).length, 0)
      })
    }
    const nested = NESTED_REINVENTION[name]
    if (nested) {
      const nestedGround = await foreignReinventionGround(pack, nested[0], nested[1])
      check('reinvented ignores matching methods owned by separate types', () => {
        assert.equal(foreignReinvented.run(nestedGround).length, 0)
      })
    }
    const wrapped = WRAPPED_REINVENTION[name]
    if (wrapped) {
      const wrappedGround = await foreignReinventionGround(pack, wrapped.same, wrapped.same)
      check('reinvented sees reusable declarations through module-level wrappers', () => {
        assert.ok(foreignReinvented.run(wrappedGround).length >= 1)
      })
      if (wrapped.differentScope) {
        const otherScopeGround = await foreignReinventionGround(pack, wrapped.same, wrapped.differentScope)
        check('reinvented keeps language namespaces separate', () => {
          assert.equal(foreignReinvented.run(otherScopeGround).length, 0)
        })
      }
      if (wrapped.differentWrapper) {
        const otherWrapperGround = await foreignReinventionGround(pack, wrapped.same, wrapped.differentWrapper)
        check('reinvented keeps decorator and template semantics in the fingerprint', () => {
          assert.equal(foreignReinvented.run(otherWrapperGround).length, 0)
        })
      }
    }
    if (name === 'cpp') {
      const first = [
        'namespace A { const int SCALE = 2; int normalizePayload(int value) { return value * SCALE; } }',
        'namespace B { const int SCALE = 3; }',
        '',
      ].join('\n')
      const shadowed = [
        'namespace B { const int SCALE = 2; }',
        'namespace A { const int SCALE = 3; int normalizePayload(int value) { return value * SCALE; } }',
        '',
      ].join('\n')
      const shadowedGround = await foreignReinventionGround(pack, first, shadowed)
      check('reinvented resolves C++ module bindings in the declaration namespace', () => {
        assert.equal(foreignReinvented.run(shadowedGround).length, 0)
      })
    }
    if (name === 'php') {
      const first = [
        '<?php namespace A { const SCALE = 2; function normalizePayload($value) { return $value * SCALE; } }',
        'namespace B { const SCALE = 3; }',
        '',
      ].join('\n')
      const shadowed = [
        '<?php namespace B { const SCALE = 2; }',
        'namespace A { const SCALE = 3; function normalizePayload($value) { return $value * SCALE; } }',
        '',
      ].join('\n')
      const shadowedGround = await foreignReinventionGround(pack, first, shadowed)
      check('reinvented resolves PHP module bindings in the declaration namespace', () => {
        assert.equal(foreignReinvented.run(shadowedGround).length, 0)
      })
    }
    if (name === 'go') {
      const linux = '//go:build linux\npackage sample\nfunc NormalizePayload() bool { return true }\n'
      const windows = linux.replace('linux', 'windows')
      const buildConstraintGrounds = await foreignReinventionPair(pack, linux, windows)
      check('reinvented preserves an exact Go build constraint control', () => {
        assert.ok(foreignReinvented.run(buildConstraintGrounds.control).length >= 1)
      })
      check('reinvented keeps different Go build constraints separate', () => {
        assert.equal(foreignReinvented.run(buildConstraintGrounds.variant).length, 0)
      })
    }
    if (name === 'c#') {
      const fileLocal = 'file class NormalizePayload { bool Run() { return true; } }\n'
      const fileLocalGround = await foreignReinventionGround(pack, fileLocal, fileLocal)
      check('reinvented ignores C# file-local declarations', () => {
        assert.equal(foreignReinvented.run(fileLocalGround).length, 0)
      })
    }
    if (name === 'rust') {
      const unix = '#[cfg(unix)]\npub fn normalize_payload() -> bool { true }\n'
      const windows = unix.replace('unix', 'windows')
      const cfgGrounds = await foreignReinventionPair(pack, unix, windows)
      check('reinvented preserves an exact Rust cfg control', () => {
        assert.ok(foreignReinvented.run(cfgGrounds.control).length >= 1)
      })
      check('reinvented keeps different Rust cfg declarations separate', () => {
        assert.equal(foreignReinvented.run(cfgGrounds.variant).length, 0)
      })
      const selfVisible = 'pub(self) fn normalize_payload() -> bool { true }\n'
      const selfVisibleGround = await foreignReinventionGround(pack, selfVisible, selfVisible)
      check('reinvented ignores Rust visibility that needs a module graph', () => {
        assert.equal(foreignReinvented.run(selfVisibleGround).length, 0)
      })
      const traitMethodGround = await rustTraitMethodGround(pack)
      check('reinvented ignores a trait method repeated by a test double', () => {
        assert.equal(foreignReinvented.run(traitMethodGround).length, 0)
      })
      const continuation = 'fn release(slot: &Slot, force: bool) -> bool {\n    slot.close()\n}\n'
      const conditionalReturn = [
        'fn release(slot: &Slot, force: bool) -> bool {',
        '    if !slot.is_ready() {',
        '        if force { return false; }',
        '        slot.record_miss();',
        '    }',
        '    slot.close()',
        '}',
        '',
      ].join('\n')
      const withAlternative = [
        'fn release(slot: &Slot, force: bool) -> bool {',
        '    if !slot.is_ready() { return false; } else { slot.record_ready(); }',
        '    slot.close()',
        '}',
        '',
      ].join('\n')
      const conditionalGround = await foreignGuardGround(pack, conditionalReturn, continuation)
      const alternativeGround = await foreignGuardGround(pack, withAlternative, continuation)
      check('dropped-guard ignores a branch that only conditionally returns', () => {
        assert.equal(foreignDroppedGuard.run(conditionalGround).length, 0)
      })
      check('dropped-guard ignores a removed conditional with an alternative', () => {
        assert.equal(foreignDroppedGuard.run(alternativeGround).length, 0)
      })
    }
  }

  const guardCase = GUARD_CASES[name]
  if (guardCase) {
    assert.ok(guardCase.before.includes(guardCase.guard), 'guard fixture cannot remove its guard')
    const deletionGround = await foreignGuardGround(pack, guardCase.before, guardCase.before.replace(guardCase.guard, ''))
    const refactorGround = await foreignGuardGround(pack, guardCase.before, guardCase.extracted)
    check('dropped-guard detects a guard-only deletion', () => {
      assert.ok(foreignDroppedGuard.run(deletionGround).length >= 1)
    })
    check('dropped-guard ignores a guarded operation extracted behind a helper or method', () => {
      assert.equal(foreignDroppedGuard.run(refactorGround).length, 0)
    })
    const absorption = GUARD_ABSORPTION[name]!
    const absorbed = guardCase.before
      .replace(absorption[0], absorption[1])
      .replace(guardCase.guard, '')
    assert.notEqual(absorbed, guardCase.before, 'guard-absorption fixture did not mutate')
    const absorptionGround = await foreignGuardGround(pack, guardCase.before, absorbed)
    check('dropped-guard ignores a guard absorbed by an already-called helper or method', () => {
      assert.equal(foreignDroppedGuard.run(absorptionGround).length, 0)
    })
    const contractMutation = GUARD_CONTRACT_MUTATION[name]
    assert.ok(contractMutation, 'no callable-contract mutation fixture written')
    const withoutGuard = guardCase.before.replace(guardCase.guard, '')
    const changedContract = withoutGuard.replace(contractMutation[0], contractMutation[1])
    assert.notEqual(changedContract, withoutGuard, 'callable-contract fixture did not mutate')
    const contractGround = await foreignGuardGround(pack, guardCase.before, changedContract)
    check('dropped-guard abstains when the callable contract changes', () => {
      assert.equal(foreignDroppedGuard.run(contractGround).length, 0)
    })
    if (name === 'go' || name === 'java' || name === 'kotlin') {
      const beforeScoped = withFileScope(name, guardCase.before, 'alpha')
      const afterScoped = withFileScope(name, withoutGuard, 'beta')
      const packageGround = await foreignGuardGround(pack, beforeScoped, afterScoped)
      check('dropped-guard abstains when the language package changes', () => {
        assert.equal(foreignDroppedGuard.run(packageGround).length, 0)
      })
    }
    if (name === 'go') {
      const tagChangeGround = await foreignGuardGround(pack, guardCase.before, withoutGuard, {
        path: 'src/platform.go',
        before: '//go:build linux\npackage sample\n',
        after: '//go:build windows\npackage sample\n',
      })
      check('dropped-guard treats a Go build-tag edit as another executable change', () => {
        assert.equal(foreignDroppedGuard.run(tagChangeGround).length, 0)
      })
    }

    const ownerGuard = OWNER_GUARDS[name]
    if (ownerGuard) {
      assert.ok(ownerGuard.before.includes(ownerGuard.guard), 'owner guard fixture cannot remove its guard')
      const sameOwner = ownerGuard.before.replace(ownerGuard.guard, '')
      const movedOwner = sameOwner.replaceAll('Primary', 'Recording')
      const sameOwnerGround = await foreignGuardGround(pack, ownerGuard.before, sameOwner)
      const movedOwnerGround = await foreignGuardGround(pack, ownerGuard.before, movedOwner)
      check('dropped-guard detects a guard-only deletion inside an owner', () => {
        assert.ok(foreignDroppedGuard.run(sameOwnerGround).length >= 1)
      })
      check('dropped-guard abstains when the callable moves to another owner', () => {
        assert.equal(foreignDroppedGuard.run(movedOwnerGround).length, 0)
      })
    }
    if (name === 'java') {
      const nestedBefore = [
        'class Runner {',
        '  static boolean release(Slot slot, boolean enabled) {',
        '    if (enabled) {',
        '      if (slot == null) return false;',
        '      return slot.close();',
        '    }',
        '    return true;',
        '  }',
        '}',
        '',
      ].join('\n')
      const nestedAfter = nestedBefore.replace('      if (slot == null) return false;\n', '')
      const strengthenedAfter = nestedAfter.replace('if (enabled)', 'if (enabled && slot != null)')
      const siblingBefore = nestedBefore.replace('    if (enabled) {', '    observe(slot);\n    if (enabled) {')
      const siblingAfter = nestedAfter.replace('    if (enabled) {', '    ensureSlot(slot);\n    if (enabled) {')
      const nestedGround = await foreignGuardGround(pack, nestedBefore, nestedAfter)
      const strengthenedGround = await foreignGuardGround(pack, nestedBefore, strengthenedAfter)
      const siblingGround = await foreignGuardGround(pack, siblingBefore, siblingAfter)
      check('dropped-guard detects a guard-only deletion under stable control flow', () => {
        assert.ok(foreignDroppedGuard.run(nestedGround).length >= 1)
      })
      check('dropped-guard abstains when an ancestor condition replaces the guard', () => {
        assert.equal(foreignDroppedGuard.run(strengthenedGround).length, 0)
      })
      check('dropped-guard abstains when a sibling statement changes too', () => {
        assert.equal(foreignDroppedGuard.run(siblingGround).length, 0)
      })

      const importBefore = [
        'import alpha.Slot;',
        'class Runner {',
        '  static boolean release(Slot slot) {',
        '    if (slot == null) return false;',
        '    return slot.close();',
        '  }',
        '}',
        '',
      ].join('\n')
      const importAfter = importBefore
        .replace('import alpha.Slot;', 'import beta.Slot;')
        .replace('    if (slot == null) return false;\n', '')
      const importGround = await foreignGuardGround(pack, importBefore, importAfter)
      check('dropped-guard abstains when an import binding changes', () => {
        assert.equal(foreignDroppedGuard.run(importGround).length, 0)
      })

      const repeatedBefore = [
        'class Runner {',
        '  static boolean release(Slot slot, boolean enabled) {',
        '    if (slot == null) return false;',
        '    if (enabled) {',
        '      if (slot /* repeated */ == null) return false;',
        '      return slot.close();',
        '    }',
        '    return true;',
        '  }',
        '}',
        '',
      ].join('\n')
      const repeatedAfter = repeatedBefore.replace(
        '      if (slot /* repeated */ == null) return false;\n',
        '',
      )
      const repeatedGround = await foreignGuardGround(pack, repeatedBefore, repeatedAfter)
      check('dropped-guard matches remaining guards without comments or layout', () => {
        assert.equal(foreignDroppedGuard.run(repeatedGround).length, 0)
      })
    }
    if (name === 'c#') {
      const fileScopedBefore = [
        'namespace Sample;',
        'class First {}',
        'class Second {',
        '  bool Release(object slot) {',
        '    if (slot == null) return false;',
        '    return true;',
        '  }',
        '}',
        '',
      ].join('\n')
      const fileScopedAfter = fileScopedBefore.replace('    if (slot == null) return false;\n', '')
      const fileScopedGround = await foreignGuardGround(pack, fileScopedBefore, fileScopedAfter)
      check('dropped-guard reaches later types in a file-scoped namespace', () => {
        assert.ok(foreignDroppedGuard.run(fileScopedGround).length >= 1)
      })
    }
    if (name === 'ruby') {
      const modifierBefore = [
        'def ready(slot)',
        '  true',
        'end',
        'def release(slot)',
        '  return false if !ready(slot)',
        '  true',
        'end',
        '',
      ].join('\n')
      const modifierAfter = modifierBefore.replace('  return false if !ready(slot)\n', '')
      const modifierGround = await foreignGuardGround(pack, modifierBefore, modifierAfter)
      check('dropped-guard detects a postfix early-return guard', () => {
        assert.ok(foreignDroppedGuard.run(modifierGround).length >= 1)
      })
      const unlessBefore = modifierBefore.replace('return false if !ready(slot)', 'return false unless ready(slot)')
      const unlessAfter = unlessBefore.replace('  return false unless ready(slot)\n', '')
      const unlessGround = await foreignGuardGround(pack, unlessBefore, unlessAfter)
      check('dropped-guard detects a postfix unless guard', () => {
        assert.ok(foreignDroppedGuard.run(unlessGround).length >= 1)
      })
    }
  }
  return failed
}

/** Signature comparison is Python-only for now, and is what decides a contract break. */
async function pythonSignatures(): Promise<number> {
  const pack = PACKS.find((p) => p.name === 'python')!
  let failed = 0
  const check = (label: string, fn: () => void): void => {
    try {
      fn()
      console.log('  ok   python signatures: ' + label)
    } catch (e) {
      failed++
      console.log('  FAIL python signatures: ' + label + '\n       ' + (e as Error).message)
    }
  }

  const of = async (src: string) => {
    const tree = await parse(pack, src)
    return pack.signatures!(tree!.rootNode)
  }

  const one = await of('def send(to: str) -> bool:\n    return True\n')
  const two = await of('def send(to: str, subject: str) -> bool:\n    return True\n')
  const defaulted = await of('def send(to: str, subject: str = "hi") -> bool:\n    return True\n')
  const splat = await of('def send(to: str, *args, **kwargs) -> bool:\n    return True\n')
  const method = await of('class A:\n    def send(self, to: str) -> bool:\n        return True\n')

  check('counts what a caller must supply', () => {
    assert.equal(one.get('send')!.required, 1)
    assert.equal(two.get('send')!.required, 2)
  })
  check('a default does not demand anything of a caller', () => {
    assert.equal(defaulted.get('send')!.required, 1)
  })
  check('*args and **kwargs demand nothing', () => {
    assert.equal(splat.get('send')!.required, 1)
  })
  check('self is bound, not passed', () => {
    assert.equal(method.get('send')!.required, 1)
  })
  return failed
}

/** Test and docstring conventions are per-language data; these are Python's. */
async function pythonConventions(): Promise<number> {
  const pack = PACKS.find((p) => p.name === 'python')!
  let failed = 0
  const check = (label: string, fn: () => void): void => {
    try {
      fn()
      console.log('  ok   python conventions: ' + label)
    } catch (e) {
      failed++
      console.log('  FAIL python conventions: ' + label + '\n       ' + (e as Error).message)
    }
  }
  const tests = async (src: string) => pack.tests!((await parse(pack, src))!.rootNode)
  const docs = async (src: string) => pack.documentedParams!((await parse(pack, src))!.rootNode)
  const Q = '"' + '"' + '"'

  const bare = await tests('def test_a():\n    do_work()\n')
  const asserted = await tests('def test_a():\n    assert do_work() == 1\n')
  const unittest = await tests('class T:\n    def test_a(self):\n        self.assertEqual(do_work(), 1)\n')
  const raises = await tests('def test_a():\n    with pytest.raises(ValueError):\n        do_work()\n')
  const placeholder = await tests('def test_a():\n    pass\n')

  check('a test that runs code and proves nothing is caught', () => {
    assert.equal(bare[0]!.provesNothing, true)
  })
  check('a plain assert counts as proof', () => {
    assert.equal(asserted[0]!.provesNothing, false)
  })
  check('unittest assertion methods count as proof', () => {
    assert.equal(unittest[0]!.provesNothing, false)
  })
  check('a raises block counts as proof', () => {
    assert.equal(raises[0]!.provesNothing, false)
  })
  check('a placeholder body is not a claim that came out empty', () => {
    assert.equal(placeholder[0]!.provesNothing, false)
  })
  check('an assertion exposes what it asserts about, for drift', () => {
    assert.equal(asserted[0]!.assertions[0]!.subject, 'do_work()')
    assert.equal(asserted[0]!.assertions[0]!.expected, '1')
    assert.equal(unittest[0]!.assertions[0]!.expected, '1')
  })

  const google = await docs('def f(a, b):\n    ' + Q + 'Do it.\n\n    Args:\n        a: first\n        c: nope\n    ' + Q + '\n    return a\n')
  const rest = await docs('def f(a):\n    ' + Q + 'Do it.\n\n    :param a: first\n    :param z: nope\n    ' + Q + '\n    return a\n')
  const undocumented = await docs('def f(a):\n    return a\n')

  check('a Google-style Args block is read', () => {
    assert.deepEqual(google[0]!.documented.map((d) => d.name), ['a', 'c'])
    assert.deepEqual(google[0]!.declared, ['a', 'b'])
  })
  check('a reST :param: block is read', () => {
    assert.deepEqual(rest[0]!.documented.map((d) => d.name), ['a', 'z'])
  })
  check('a function with no docstring makes no claim to contradict', () => {
    assert.equal(undocumented.length, 0)
  })
  return failed
}

/** A change inside a string literal must never read as "formatting only". */
async function literalsAreVisible(): Promise<number> {
  let failed = 0
  const check = (label: string, fn: () => void): void => {
    try {
      fn()
      console.log('  ok   literals: ' + label)
    } catch (e) {
      failed++
      console.log('  FAIL literals: ' + label + '\n       ' + (e as Error).message)
    }
  }

  const sample: Record<string, (v: string) => string> = {
    rust: (v) => 'fn f() { let x = "' + v + '"; }',
    go: (v) => 'package m\nvar x = "' + v + '"\n',
    java: (v) => 'class A { String x = "' + v + '"; }',
    cpp: (v) => 'auto x = "' + v + '";',
    python: (v) => 'x = "' + v + '"\n',
    ruby: (v) => 'x = "' + v + '"\n',
  }

  for (const [name, build] of Object.entries(sample)) {
    const pack = PACKS.find((p) => p.name === name)
    if (!pack) continue
    const a = await parse(pack, build('alpha_e_gguf'))
    const b = await parse(pack, build('alpha_d_gguf'))
    check(name + ': a changed string literal is part of the token stream', () => {
      assert.ok(a && b)
      assert.notEqual(
        JSON.stringify(tokensFor(a.rootNode, pack)),
        JSON.stringify(tokensFor(b.rootNode, pack)),
        name + ' tokenizes two different strings identically',
      )
    })
  }
  return failed
}

async function main(): Promise<number> {
  const target = process.argv[2]
  if (target) return one(target)

  console.log('\nlanguage packs (one process each)')
  let failed = (await pythonSignatures()) + (await pythonConventions()) + (await literalsAreVisible())
  for (const pack of PACKS) {
    try {
      process.stdout.write(execFileSync(process.execPath, [process.argv[1]!, pack.name], { encoding: 'utf8' }))
    } catch (e) {
      const err = e as { stdout?: string; status?: number | null; signal?: string | null }
      process.stdout.write(err.stdout ?? '')
      // a child killed by the runtime rather than by a failed assertion
      if (err.status === null || err.signal) {
        console.log('  FAIL ' + pack.name + ': the process died (' + (err.signal ?? 'no exit code') + ')')
      }
      failed++
    }
  }
  return failed
}

main().then((failed) => {
  // only the parent summarises; a child reports just its own language
  if (!process.argv[2]) {
    if (failed > 0) console.error('\n' + failed + ' language pack(s) failed')
    else console.log('\nall ' + PACKS.length + ' language packs pass')
  }
  // Deliberately not process.exit(): V8 is still compiling the wasm grammar in the
  // background, and tearing the process down underneath that work crashes it. Setting
  // the code and letting the loop drain costs nothing and ends cleanly.
  process.exitCode = failed > 0 ? 1 : 0
})
