### Maintenance

* The release workflow publishes the packed tarball to npm with trusted publishing after the GitHub Release is created. The first npm publish is manual, once; if only that step fails, re-run the workflow with the existing tag, because merging again does nothing once the tag exists. A package name other than `chrome-cdp-ex` is skipped, including an old `pi-chrome-cdp` tag.
