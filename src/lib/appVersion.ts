// The version a build reports: the upstream version, with the community
// release label after it when the build is one ("0.4.0-cf1").
export const APP_VERSION = __APP_RELEASE__
  ? `${__APP_VERSION__}-${__APP_RELEASE__}`
  : __APP_VERSION__;
