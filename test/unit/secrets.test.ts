import { describe, expect, it } from 'vitest';
import { containsSecret, redactSecrets } from '../../src/index.js';
import { setupEnv } from '../helpers.js';

// Synthetic, non-functional credentials assembled at runtime so scanners do not flag this file.
const fake = {
  aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
  awsSecret: 'aws_secret_access_key = ' + 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  gh: 'ghp_' + 'a'.repeat(36),
  ghPat: 'github_pat_' + 'B'.repeat(30),
  gitlab: 'glpat-' + 'c'.repeat(20),
  slack: 'xoxb-' + '1234567890-abcdefghij',
  stripe: 'sk_live_' + 'd'.repeat(24),
  anthropic: 'sk-ant-' + 'api03-' + 'e'.repeat(30),
  openai: 'sk-proj-' + 'f'.repeat(40),
  google: 'AIza' + 'g'.repeat(35),
  npm: 'npm_' + 'h'.repeat(36),
  jwt:
    'eyJhbGciOiJIUzI1NiJ9' +
    '.' +
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0' +
    '.' +
    'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow' + 'IBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
  url: 'postgres://admin:' + 'S3cretPassw0rd' + '@db.internal:5432/app',
  bearer: 'Authorization: Bearer ' + 'abcdefghijklmnopqrstuvwxyz012345',
  assign: 'DB_PASSWORD=' + 'hunter2hunter2',
  quoted: 'api_key: "' + 'zzzzzzzzzzzzzzzz' + '"',
};

describe('secret redaction', () => {
  // What must not survive redaction for each sample (the credential, not its harmless context).
  const mustNotSurvive: Record<keyof typeof fake, string> = {
    aws: fake.aws,
    awsSecret: 'bPxRfiCYEXAMPLEKEY',
    gh: fake.gh,
    ghPat: fake.ghPat,
    gitlab: fake.gitlab,
    slack: fake.slack,
    stripe: fake.stripe,
    anthropic: fake.anthropic,
    openai: fake.openai,
    google: fake.google,
    npm: fake.npm,
    jwt: 'dozjgNryP4J3jVmNHl0w5N',
    pem: 'MIIEowIBAAKCAQEA',
    url: 'S3cretPassw0rd',
    bearer: 'abcdefghijklmnopqrstuvwxyz012345',
    assign: 'hunter2hunter2',
    quoted: 'zzzzzzzzzzzzzzzz',
  };

  it.each(Object.entries(fake) as [keyof typeof fake, string][])('redacts %s', (kind, secret) => {
    const r = redactSecrets(`config note: ${secret} end`);
    expect(r.count).toBeGreaterThan(0);
    expect(r.text).toContain('[REDACTED:');
    expect(r.text).not.toContain(mustNotSurvive[kind]);
    expect(r.text.startsWith('config note: ')).toBe(true);
  });

  it('keeps surrounding text and is idempotent', () => {
    const r1 = redactSecrets(`token for CI is ${fake.gh}, rotate monthly`);
    expect(r1.text).toBe('token for CI is [REDACTED:github_token], rotate monthly');
    const r2 = redactSecrets(r1.text);
    expect(r2.count).toBe(0);
    expect(r2.text).toBe(r1.text);
  });

  it('does not flag benign technical text', () => {
    for (const s of [
      'Set max_tokens: 2000 in the request',
      'password reset emails are sent via SES',
      'Read the key from process.env.API_KEY',
      'DB_PASSWORD=${DB_PASSWORD}',
      'api_key: <your-key-here>',
      'The token bucket allows 100 requests per minute',
      'Use sha256 hashes for content ids',
      'commit 3f2a9c1e7b6d5a4f3e2d1c0b9a8f7e6d5c4b3a29',
    ]) {
      expect(containsSecret(s), s).toBe(false);
    }
  });

  it('redacts before persistence in title, content, sourceRef and tags', () => {
    const env = setupEnv();
    const { pm, dm } = env.project('s');
    const r = pm.save({
      type: 'fact',
      title: `Deploy key ${fake.aws}`,
      content: `Use ${fake.stripe} for live payments and ${fake.url}`,
      sourceRef: `https://example.com/?token=${fake.gh}`,
    });
    expect(r.redactions.count).toBeGreaterThanOrEqual(4);
    expect(r.redactions.kinds).toEqual(
      expect.arrayContaining(['aws_access_key_id', 'stripe_key', 'url_credentials', 'github_token']),
    );
    const raw =
      JSON.stringify(dm.db.prepare('SELECT * FROM memories').all()) +
      JSON.stringify(dm.db.prepare('SELECT * FROM memory_events').all()) +
      JSON.stringify(dm.db.prepare('SELECT * FROM memories_fts').all());
    for (const s of [fake.aws, fake.stripe, 'S3cretPassw0rd', fake.gh]) expect(raw).not.toContain(s);
    expect(r.memory.redactions).toBe(r.redactions.count);
  });

  it('redacts secrets introduced by updates', () => {
    const { pm } = setupEnv().project('s');
    const { memory } = pm.save({ type: 'fact', title: 'Webhook', content: 'Webhook config' });
    const u = pm.update(memory.id, { content: `Webhook token ${fake.slack}` });
    expect(u.redactions).toBe(1);
    expect(u.memory.content).toBe('Webhook token [REDACTED:slack_token]');
  });

  it('reject policy refuses writes containing secrets without storing anything', () => {
    const env = setupEnv();
    const dm = env.open({ config: { secretPolicy: 'reject' } });
    const { pm } = env.project('s', dm);
    expect(() => pm.save({ type: 'fact', title: 'creds', content: fake.openai })).toThrowError(
      expect.objectContaining({ code: 'SECRET_DETECTED' }),
    );
    expect(pm.stats().total).toBe(0);
  });
});
