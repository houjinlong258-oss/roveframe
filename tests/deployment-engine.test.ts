/**
 * Phase 6 — Deployment Engine
 * tests/deployment-engine.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateDeploymentPlan,
  validateDeploymentConfig,
  DEFAULT_DEPLOYMENT_CONFIG,
} from '../src/lib/deployment/generator';

describe('Deployment Engine: config validation', () => {
  test('defaults are valid', () => {
    const r = validateDeploymentConfig({});
    assert.equal(r.valid, true);
    assert.deepEqual(r.config, DEFAULT_DEPLOYMENT_CONFIG);
  });

  test('rejects bad domain', () => {
    assert.equal(validateDeploymentConfig({ domain: 'not a domain!' }).valid, false);
    assert.equal(validateDeploymentConfig({ domain: 'app.example.com' }).valid, true);
  });

  test('rejects bad port / env / image name', () => {
    assert.equal(validateDeploymentConfig({ port: 0 }).valid, false);
    assert.equal(validateDeploymentConfig({ port: 70000 }).valid, false);
    // @ts-expect-error 故意传入非法环境
    assert.equal(validateDeploymentConfig({ environment: 'dev' }).valid, false);
    assert.equal(validateDeploymentConfig({ imageName: 'Bad Name' }).valid, false);
  });

  test('rejects bad ssl email and health path', () => {
    assert.equal(validateDeploymentConfig({ sslEmail: 'nope' }).valid, false);
    assert.equal(validateDeploymentConfig({ healthPath: 'en' }).valid, false);
  });
});

describe('Deployment Engine: plan generation', () => {
  test('generates 5 deterministic artifacts', () => {
    const plan = generateDeploymentPlan({ domain: 'app.example.com', sslEmail: 'ops@example.com' });
    const paths = plan.artifacts.map((a) => a.path).sort();
    assert.deepEqual(paths, ['.env.template', 'Dockerfile', 'deploy.sh', 'deploy/nginx.conf', 'docker-compose.yml']);
    // 确定性：同输入同输出
    const again = generateDeploymentPlan({ domain: 'app.example.com', sslEmail: 'ops@example.com' });
    assert.equal(JSON.stringify(plan), JSON.stringify(again));
  });

  test('compose uses configured port and health path', () => {
    const plan = generateDeploymentPlan({ port: 8080, healthPath: '/health' });
    const compose = plan.artifacts.find((a) => a.path === 'docker-compose.yml');
    assert.ok(compose);
    assert.match(compose.content, /127\.0\.0\.1:8080:8080/);
    assert.match(compose.content, /http:\/\/127\.0\.0\.1:8080\/health/);
  });

  test('nginx config references domain and SSE-friendly timeouts', () => {
    const plan = generateDeploymentPlan({ domain: 'app.example.com' });
    const nginx = plan.artifacts.find((a) => a.path === 'deploy/nginx.conf');
    assert.ok(nginx);
    assert.match(nginx.content, /server_name app\.example\.com/);
    assert.match(nginx.content, /proxy_read_timeout 120s/);
    assert.match(nginx.content, /letsencrypt\/live\/app\.example\.com/);
  });

  test('deploy.sh includes certbot when domain set, skips otherwise', () => {
    const withDomain = generateDeploymentPlan({ domain: 'app.example.com', sslEmail: 'ops@example.com' });
    const sh1 = withDomain.artifacts.find((a) => a.path === 'deploy.sh');
    assert.ok(sh1?.executable);
    assert.match(sh1.content, /certbot --nginx -d app\.example\.com .*-m ops@example\.com/);

    const noDomain = generateDeploymentPlan({});
    const sh2 = noDomain.artifacts.find((a) => a.path === 'deploy.sh');
    assert.match(sh2?.content ?? '', /SSL skipped/);
  });

  test('deploy.sh runs migrations and health check', () => {
    const plan = generateDeploymentPlan({});
    const sh = plan.artifacts.find((a) => a.path === 'deploy.sh');
    assert.match(sh?.content ?? '', /migrate-production-hardening\.sql/);
    assert.match(sh?.content ?? '', /Health check/);
  });

  test('invalid config throws', () => {
    assert.throws(() => generateDeploymentPlan({ port: -1 }));
  });

  test('plan includes human-readable steps', () => {
    const plan = generateDeploymentPlan({});
    assert.equal(plan.steps.length, 5);
  });
});
