// Local regression for signing a downloaded ZIP with buildPlugin excluded.
// Requires Java 21, OpenSSL and the Gradle dependencies. Never uploads anything.
// Run: node scripts/release/check-jetbrains-signing.mjs [--offline]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = mkdtempSync(path.join(tmpdir(), 'packageawy-signing-'));
const project = path.join(temporary, 'jetbrains');
const options = process.argv.slice(2);
assert.ok(options.every((option) => option === '--offline'), 'Only --offline is supported');

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: project, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} exited successfully`);
}

try {
  // Copy configuration only. A build cannot succeed without the source and bundles.
  for (const file of ['build.gradle.kts', 'settings.gradle.kts', 'gradle.properties', 'gradlew', 'gradle']) {
    cpSync(path.join(root, 'jetbrains', file), path.join(project, file), { recursive: true });
  }
  cpSync(path.join(root, 'package.json'), path.join(temporary, 'package.json'));
  writeFileSync(path.join(project, 'payload.txt'), 'Downloaded verified archive fixture\n');
  run('jar', ['--create', '--file', 'verified.zip', 'payload.txt']);
  const archive = path.join(project, 'verified.zip');
  const digest = () => createHash('sha256').update(readFileSync(archive)).digest('hex');
  const before = digest();
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1',
    '-keyout', 'private.pem', '-out', 'chain.crt', '-passout', 'pass:local-test-only',
    '-subj', '/CN=Packageawy Local Signing Test']);

  const init = path.join(temporary, 'local-publish.gradle');
  writeFileSync(init, `
    gradle.projectsEvaluated {
      def project = gradle.rootProject
      def signing = project.tasks.named('signPlugin')
      def publishing = project.tasks.named('publishPlugin')
      publishing.configure { task ->
        // Remove the real upload action. The host and token below are also local fakes.
        task.setActions([])
        // Gradle disables uploads in offline mode. Enable only this local replacement.
        task.setOnlyIf { true }
        task.host.set('http://127.0.0.1:1')
        task.doLast {
          def signed = signing.get().signedArchiveFile.get().asFile
          assert signed.isFile(): 'Signing must produce the archive'
          assert task.archiveFiles.files == [signed].toSet(): 'Publish must consume only the signed output'
          assert signing.get().archiveFile.get().asFile == project.file('verified.zip')
          assert !java.util.Arrays.equals(signed.bytes, project.file('verified.zip').bytes)
          project.file('publish-asserted.txt').text = 'Only the signed downloaded ZIP would be uploaded'
          println('Local publish assertion passed: only the signed downloaded ZIP would be uploaded')
        }
      }
      project.tasks.named('verifyPluginSignature').configure { task ->
        task.inputArchiveFile.set(signing.flatMap { it.signedArchiveFile })
        task.dependsOn(publishing)
        task.doLast { project.file('signature-verified.txt').text = 'Signature verified' }
      }
    }
    gradle.taskGraph.whenReady { graph ->
      assert !graph.allTasks.any { it.name == 'buildPlugin' }: 'buildPlugin must remain excluded'
    }
  `);
  const output = path.join(project, 'build/distributions/verified-signed.zip');
  run('./gradlew', ['publishPlugin', 'verifyPluginSignature', '-x', 'buildPlugin',
    '-Ppackageawy.publishArchive=verified.zip', '-Ppackageawy.stubSidecar=false',
    '--no-configuration-cache', '--no-daemon', '--console=plain', '-I', init, ...options], {
    ...process.env,
    JETBRAINS_PUBLISH_TOKEN: 'local-test-only',
    JETBRAINS_CERTIFICATE_CHAIN: readFileSync(path.join(project, 'chain.crt'), 'utf8'),
    JETBRAINS_PRIVATE_KEY: readFileSync(path.join(project, 'private.pem'), 'utf8'),
    JETBRAINS_PRIVATE_KEY_PASSWORD: 'local-test-only',
  });
  assert.ok(readFileSync(output).length > 0);
  assert.equal(readFileSync(path.join(project, 'publish-asserted.txt'), 'utf8'), 'Only the signed downloaded ZIP would be uploaded');
  assert.equal(readFileSync(path.join(project, 'signature-verified.txt'), 'utf8'), 'Signature verified');
  assert.equal(digest(), before, 'The verified input ZIP stays unchanged');
  console.log('Signing regression passed. The signature verified and no upload ran.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
