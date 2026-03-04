import versionRaw from './version.generated.json';

export type AppVersion = {
  version: string;
  git: {
    describe: string;
    commit: string;
    dirty: boolean;
  };
  buildTime: string;
  runtime: string;
  app: string;
  isTaggedRelease?: boolean;
};

const fallback: AppVersion = {
  version: '0.0.0',
  git: {
    describe: 'unavailable',
    commit: 'unknown',
    dirty: false
  },
  buildTime: new Date().toISOString(),
  runtime: 'node',
  app: 'archimap',
  isTaggedRelease: false
};

export const APP_VERSION: AppVersion = {
  ...fallback,
  ...(versionRaw as Partial<AppVersion>),
  git: {
    ...fallback.git,
    ...((versionRaw as Partial<AppVersion>)?.git || {})
  }
};

export const APP_REPO_URL = 'https://github.com/streletskiy/archimap';
export const APP_VERSION_DISPLAY = `${APP_VERSION.version}${APP_VERSION.isTaggedRelease ? '' : '-dev'} (${APP_VERSION.git.commit}${APP_VERSION.git.dirty ? ', dirty' : ''}, ${APP_VERSION.buildTime})`;
