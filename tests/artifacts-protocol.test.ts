import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ArtifactStreamFilter,
  artifactIdsIn,
  artifactMarker,
  extractArtifactFences,
  parseFenceInfo,
  sanitizeFileName,
  splitArtifactSegments,
} from '../src/lib/artifacts/protocol';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

test('sanitizeFileName blocks path traversal and keeps a usable extension', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'etc-passwd.txt');
  assert.equal(sanitizeFileName('..\\..\\windows\\system32\\cmd.exe'), 'windows-system32-cmd.exe');
  assert.equal(sanitizeFileName('report'), 'report.txt');
  assert.equal(sanitizeFileName('Q3 Sales.CSV'), 'Q3 Sales.CSV');
  assert.equal(sanitizeFileName(''), 'artifact.txt');
  assert.ok(!sanitizeFileName('a/'.repeat(200)).includes('/'));
});

test('parseFenceInfo validates the format and rejects plain code fences', () => {
  const parsed = parseFenceInfo('artifact:xlsx:customer-risk.xlsx');
  assert.deepEqual(parsed, {
    format: 'xlsx',
    fileName: 'customer-risk.xlsx',
    body: '',
  });
  assert.equal(parseFenceInfo('artifact:exe:evil.exe'), null);
  assert.equal(parseFenceInfo('js'), null);
  assert.equal(parseFenceInfo(''), null);
});

test('ordinary code fences pass through untouched', () => {
  const filter = new ArtifactStreamFilter();
  const text = 'Example:\n```js\nconst a = 1;\n```\ndone';
  const step = filter.push(text);
  const tail = filter.flush();
  assert.equal(step.passthrough + tail.passthrough, text);
  assert.equal(step.artifacts.length, 0);
});

test('the stream filter extracts a fence split across arbitrary chunk boundaries', () => {
  const chunks = [
    'Here is the report:\n`',
    '``artifact:csv:sales.csv\nmonth,revenue\n20',
    '24-01,1000\n2024-02,1200\n``',
    '`\nDone.',
  ];
  const filter = new ArtifactStreamFilter();
  let visible = '';
  const collected = [];
  for (const chunk of chunks) {
    const step = filter.push(chunk);
    visible += step.passthrough;
    collected.push(...step.artifacts);
  }
  const tail = filter.flush();
  visible += tail.passthrough;

  assert.equal(visible, 'Here is the report:\nDone.');
  assert.equal(collected.length, 1);
  assert.equal(collected[0].fileName, 'sales.csv');
  assert.equal(collected[0].format, 'csv');
  assert.equal(collected[0].body, 'month,revenue\n2024-01,1000\n2024-02,1200');
});

test('the stream filter extracts a JSON-spec fence for binary formats', () => {
  const spec = '{"sheets":[{"name":"Risk","columns":["Customer"],"rows":[["A"]]}]}';
  const text = `Here you go.\n\`\`\`artifact:xlsx:customer-risk.xlsx\n${spec}\n\`\`\`\nEnjoy.`;
  const filter = new ArtifactStreamFilter();
  const step = filter.push(text);
  const tail = filter.flush();
  assert.equal(step.passthrough + tail.passthrough, 'Here you go.\nEnjoy.');
  assert.equal(step.artifacts.length, 1);
  assert.equal(step.artifacts[0].format, 'xlsx');
  assert.equal(step.artifacts[0].body, spec);
});

test('an unclosed fence is returned verbatim instead of losing user content', () => {
  const filter = new ArtifactStreamFilter();
  const step = filter.push('Report:\n```artifact:csv:half.csv\nmonth,revenue');
  const tail = filter.flush();
  const visible = step.passthrough + tail.passthrough;
  assert.match(visible, /month,revenue/);
  assert.equal(step.artifacts.length, 0);
  assert.equal(tail.artifacts.length, 0);
  assert.deepEqual(tail.warnings, ['unclosed_artifact_fence']);
});

test('an empty fence body is skipped with a warning instead of creating an empty file', () => {
  const filter = new ArtifactStreamFilter();
  const step = filter.push('```artifact:csv:empty.csv\n\n```\n');
  assert.equal(step.artifacts.length, 0);
  assert.equal(step.warnings.length, 1);
});

test('extractArtifactFences parses a complete document in one pass', () => {
  const text = [
    'Two files:',
    '```artifact:md:summary.md',
    '# Summary',
    '```',
    'and',
    '```artifact:docx:report.docx',
    '{"title":"Weekly","sections":[]}',
    '```',
    'bye',
  ].join('\n');
  const result = extractArtifactFences(text);
  assert.equal(result.artifacts.length, 2);
  assert.equal(result.artifacts[0].fileName, 'summary.md');
  assert.equal(result.artifacts[0].body, '# Summary');
  assert.equal(result.artifacts[1].format, 'docx');
  assert.doesNotMatch(result.text, /artifact:/);
  assert.match(result.text, /Two files:/);
  assert.match(result.text, /bye/);
});

test('markers round-trip through ids and segments', () => {
  assert.equal(artifactMarker(ID_A), `<<artifact:${ID_A}>>`);
  const content = `Analysis done.\n\n<<artifact:${ID_A}>>\n\nAlso:\n\n<<artifact:${ID_B}>>\n\n<<artifact:${ID_A}>>\n`;
  assert.deepEqual(artifactIdsIn(content), [ID_A, ID_B]);

  const segments = splitArtifactSegments(content);
  assert.deepEqual(
    segments.map((segment) => segment.type),
    ['text', 'artifact', 'text', 'artifact', 'artifact'],
  );
  assert.equal(segments[1].value, ID_A);
  assert.equal(segments[3].value, ID_B);
  assert.equal(segments[4].value, ID_A);
});

test('text without markers yields a single text segment', () => {
  const segments = splitArtifactSegments('just words');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, 'text');
});
