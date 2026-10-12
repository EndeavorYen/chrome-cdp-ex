# Pinned Chrome stable smoke

`.github/workflows/chrome-stable-smoke.yml` runs `npm run smoke:live` on one exact Google Chrome stable build. The default CI job does not launch Chrome. This job catches stable-channel behavior differences before review.

## What is pinned

The job exports two values (see the comment in the workflow):

- `CHROME_VERSION`: `154.0.8037.57`
- `CHROME_DEB_SHA256`: `66c0645f6a19871bab2844b8537c11a0db2e7d3bea8ef85a1c7cb52a54e65a3e`

`scripts/ci/install-pinned-chrome.sh` downloads this package from the Linux pool:

`https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}-1_amd64.deb`

It checks the sha256 with `sha256sum -c`, installs the `.deb` with `apt-get install -y --allow-downgrades`, and continues only when `/opt/google/chrome/chrome --version`, after trimming whitespace, is exactly `Google Chrome ${CHROME_VERSION}`.

The smoke step sets `CDP_SMOKE_BROWSER=/opt/google/chrome/chrome`, `CDP_SMOKE_HEADLESS=1`, and `CDP_SMOKE_NO_SANDBOX=1`. `scripts/live-smoke.mjs` exits 0 when it skips. The job fails if `smoke.log` contains `SKIP live smoke`.

## Bump the pin

1. Pick a Linux stable version from <https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions>. Use the `version` field, such as `154.0.8037.57`.
2. Download that build from the pool:

   ```bash
   curl -fsSL -o "google-chrome-stable_${CHROME_VERSION}-1_amd64.deb" \
     "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}-1_amd64.deb"
   ```

3. Hash the file: `sha256sum "google-chrome-stable_${CHROME_VERSION}-1_amd64.deb"`.
4. In the same commit, set both `CHROME_VERSION` and `CHROME_DEB_SHA256` in `.github/workflows/chrome-stable-smoke.yml` to the version you downloaded and the sha256 you just computed.

Google removes old `.deb` files from the pool. A 404 on the pinned URL means that build is gone and the pin must be bumped.
