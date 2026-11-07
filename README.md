# ThankMu for Chrome: released source

The complete corresponding source of each released ThankMu browser extension, published to
meet the GNU General Public License, version 3.

**This release:** 1.1.0, tag `chrome-v1.1.0`. It is the corresponding source of every package that
release builds: `thankmu_chromium_1.1.0.zip`, `thankmu_chromium_alpha_1.1.0.zip`.

ThankMu is based on uBlock Origin Lite by Raymond Hill and contributors, under GPLv3. It is not made or endorsed by Raymond Hill.
See [`NOTICE`](NOTICE) and [`chrome_plugin/LICENSE.txt`](chrome_plugin/LICENSE.txt).

## What is here

- `chrome_plugin/`: the uBlock Origin Lite (MV3) tree this extension forks, as released.
- `thankmu/`: the ThankMu layer, and the brand and patch configuration the build applies.
- `scripts/`: the build. `scripts/ci/docker_build_chrome.sh` builds the package in a pinned
  toolchain; `scripts/verify_chrome_package.sh` and `scripts/check_store_zip.py` check the result.
- `tests/`: the test suite (`tests/run.sh`).
- `.gitlab-ci.yml`: the pipeline that builds and releases it.

## How this repository is used

ThankMu is developed privately. This repository receives **one squashed commit per public
release**, pushed by the release pipeline and tagged with that release's version. There is no
development history and no branch work here, and issues or pull requests opened here are not read.
The licence requires the source of every released binary to be public; it does not require the
development history, so that stays private.

Support and contact: https://thankmu.com/support
