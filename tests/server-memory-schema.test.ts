import { describe, expect, it } from 'vitest';
import {
  isSensitiveKeyOrValue,
  KNOWLEDGE_KEY_MAX_LENGTH,
  KNOWLEDGE_VALUE_MAX_LENGTH,
  normalizeBatchDeleteKnowledgeInput,
  normalizeKnowledgeInput,
  normalizeWorkLogInput,
  WORK_LOG_SUMMARY_MAX_LENGTH,
  WORK_LOG_TITLE_MAX_LENGTH,
} from '../src/server-memory-schema';

describe('server-memory-schema', () => {
  it('validates work log inputs', () => {
    expect(normalizeWorkLogInput({})).toEqual({ ok: false, error: 'titleRequired' });
    expect(normalizeWorkLogInput({ title: '  ' })).toEqual({ ok: false, error: 'titleRequired' });
    expect(normalizeWorkLogInput({ title: 'Check hardware' })).toEqual({ ok: false, error: 'summaryRequired' });

    const longTitle = 'a'.repeat(WORK_LOG_TITLE_MAX_LENGTH + 1);
    expect(normalizeWorkLogInput({ title: longTitle, summary: 'done' })).toEqual({
      ok: false,
      error: 'titleTooLong',
    });

    const longSummary = 'b'.repeat(WORK_LOG_SUMMARY_MAX_LENGTH + 1);
    expect(normalizeWorkLogInput({ title: 'title', summary: longSummary })).toEqual({
      ok: false,
      error: 'summaryTooLong',
    });

    const valid = normalizeWorkLogInput({
      title: '  查看服务器硬件信息  ',
      summary: '  CPU 占用正常，内存余量充足  ',
    });
    expect(valid).toEqual({
      ok: true,
      value: {
        title: '查看服务器硬件信息',
        summary: 'CPU 占用正常，内存余量充足',
      },
    });
  });

  it('validates and categorizes knowledge and credential inputs', () => {
    expect(normalizeKnowledgeInput({})).toEqual({ ok: false, error: 'keyRequired' });
    expect(normalizeKnowledgeInput({ key: 'deploy_token' })).toEqual({ ok: false, error: 'valueRequired' });

    const longKey = 'k'.repeat(KNOWLEDGE_KEY_MAX_LENGTH + 1);
    expect(normalizeKnowledgeInput({ key: longKey, value: 'v' })).toEqual({
      ok: false,
      error: 'keyTooLong',
    });

    const longVal = 'v'.repeat(KNOWLEDGE_VALUE_MAX_LENGTH + 1);
    expect(normalizeKnowledgeInput({ key: 'k', value: longVal })).toEqual({
      ok: false,
      error: 'valueTooLong',
    });

    // Auto-infers 'credential' category for keys or tokens
    const cred = normalizeKnowledgeInput({
      key: 'deploy_token',
      value: 'ghp_abcdef1234567890abcdef12345678901234',
    });
    expect(cred).toEqual({
      ok: true,
      value: {
        category: 'credential',
        key: 'deploy_token',
        value: 'ghp_abcdef1234567890abcdef12345678901234',
      },
    });

    // Respects explicit category
    const config = normalizeKnowledgeInput({
      category: 'config',
      key: 'app_port',
      value: '8080',
    });
    expect(config).toEqual({
      ok: true,
      value: {
        category: 'config',
        key: 'app_port',
        value: '8080',
      },
    });
  });

  it('detects sensitive keys or values for UI masking', () => {
    expect(isSensitiveKeyOrValue('db_password', '123456')).toBe(true);
    expect(isSensitiveKeyOrValue('api_key', 'some-key')).toBe(true);
    expect(isSensitiveKeyOrValue('token', 'ghp_12345')).toBe(true);
    expect(isSensitiveKeyOrValue('normal_key', 'normal_val')).toBe(false);
  });

  it('normalizes knowledge keys by lowercasing and replacing whitespace/hyphens with underscores', () => {
    const k1 = normalizeKnowledgeInput({ key: '  Deploy-Token  ', value: 'token123' });
    expect(k1.ok).toBe(true);
    if (k1.ok) expect(k1.value.key).toBe('deploy_token');

    const k2 = normalizeKnowledgeInput({ key: 'API Key V2', value: 'key123' });
    expect(k2.ok).toBe(true);
    if (k2.ok) expect(k2.value.key).toBe('api_key_v2');
  });

  it('validates batch delete knowledge input and removes duplicates', () => {
    expect(normalizeBatchDeleteKnowledgeInput(null)).toEqual({ ok: false, error: 'invalidBody' });
    expect(normalizeBatchDeleteKnowledgeInput({})).toEqual({ ok: false, error: 'idsRequired' });
    expect(normalizeBatchDeleteKnowledgeInput({ ids: [] })).toEqual({ ok: false, error: 'idsRequired' });
    expect(normalizeBatchDeleteKnowledgeInput({ ids: ['abc'] })).toEqual({ ok: false, error: 'invalidId' });
    expect(normalizeBatchDeleteKnowledgeInput({ ids: [0, -1] })).toEqual({ ok: false, error: 'invalidId' });

    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
    expect(normalizeBatchDeleteKnowledgeInput({ ids: tooMany })).toEqual({
      ok: false,
      error: 'tooManyIds',
    });

    const valid = normalizeBatchDeleteKnowledgeInput({ ids: [1, 2, 3, 2, 1] });
    expect(valid).toEqual({
      ok: true,
      value: { ids: [1, 2, 3] },
    });
  });
});
