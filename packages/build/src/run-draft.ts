import { promises as fs } from 'fs';
import path from 'path';
import type { Config } from './config';
import { ALL_PACKAGE_VARIANTS, getReleaseVersionFromTag } from './config';
import { uploadArtifactToDownloadCenter as uploadArtifactToDownloadCenterFn } from './download-center';
import { downloadArtifactFromEvergreen as downloadArtifactFromEvergreenFn } from './evergreen';
import { generateChangelog as generateChangelogFn } from './git';
import type { GithubRepo } from '@mongodb-js/devtools-github-repo';
import { getPackageFile } from './packaging';
import { sign } from '@mongodb-js/signing-utils';

export async function runDraft(
  config: Config,
  githubRepo: GithubRepo,
  uploadToDownloadCenter: typeof uploadArtifactToDownloadCenterFn = uploadArtifactToDownloadCenterFn,
  downloadArtifactFromEvergreen: typeof downloadArtifactFromEvergreenFn = downloadArtifactFromEvergreenFn,
  ensureGithubReleaseExistsAndUpdateChangelog: typeof ensureGithubReleaseExistsAndUpdateChangelogFn = ensureGithubReleaseExistsAndUpdateChangelogFn
): Promise<void> {
  if (!config.packageInformation) {
    throw new Error('Missing package information from config');
  }

  const githubReleaseTag = `v${config.version}`;
  const tmpDir = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'tmp',
    `draft-${Date.now()}`
  );
  await fs.mkdir(tmpDir, { recursive: true });

  for await (const variant of ALL_PACKAGE_VARIANTS) {
    const tarballFile = getPackageFile(variant, config.packageInformation);
    console.info(
      `mongosh: processing artifact for ${variant} - ${tarballFile.path}`
    );

    const downloadedArtifact = await downloadArtifactFromEvergreen(
      tarballFile.path,
      config.project as string,
      config.triggeringGitTag,
      tmpDir
    );

    const clientOptions = {
      client: 'local' as const,
      signingMethod: getSigningMethod(tarballFile.path),
    };

    await sign(downloadedArtifact, clientOptions);

    const signatureFile = `${downloadedArtifact}.sig`;
    return;

    if (
      !config.triggeringGitTag ||
      !getReleaseVersionFromTag(config.triggeringGitTag)
    ) {
      console.error(
        'mongosh: skipping draft as not triggered by a git tag that matches a draft/release tag'
      );
      return;
    }

    await ensureGithubReleaseExistsAndUpdateChangelog(
      config.version,
      githubReleaseTag,
      githubRepo
    );

    await Promise.all(
      [
        [downloadedArtifact, tarballFile.contentType],
        [signatureFile, 'application/pgp-signature'],
      ].flatMap(([path, contentType]) =>
        path
          ? [
              uploadToDownloadCenter(
                path,
                config.downloadCenterAwsKey as string,
                config.downloadCenterAwsSecret as string
              ),

              githubRepo.uploadReleaseAsset(githubReleaseTag, {
                path,
                contentType,
              }),
            ]
          : []
      )
    );
  }
}

function getSigningMethod(src: string) {
  switch (path.extname(src)) {
    case '.exe':
    case '.msi':
      return 'jsign' as const;
    case '.rpm':
      return 'rpm_gpg' as const;
    default:
      return 'gpg' as const;
  }
}

export async function ensureGithubReleaseExistsAndUpdateChangelogFn(
  releaseVersion: string,
  releaseTag: string,
  githubRepo: GithubRepo,
  generateChangelog: typeof generateChangelogFn = generateChangelogFn
): Promise<void> {
  const previousReleaseTag = await githubRepo.getPreviousReleaseTag(
    releaseVersion
  );
  console.info(
    `mongosh: Detected previous release tag ${previousReleaseTag?.name}`
  );

  let changelog = `See an overview of all solved issues [in Jira](https://jira.mongodb.org/issues/?jql=project%20%3D%20MONGOSH%20AND%20fixVersion%20%3D%20${releaseVersion})`;
  if (previousReleaseTag) {
    const generatedChangelog = generateChangelog(previousReleaseTag.name);
    if (generatedChangelog) {
      changelog = `${generatedChangelog}\n\n${changelog}`;
    }
  }

  console.info(
    `mongosh: Updating release ${releaseTag}, changelog:\n${changelog}`
  );
  await githubRepo.updateDraftRelease({
    name: releaseVersion,
    tag: releaseTag,
    notes: changelog,
  });
}
