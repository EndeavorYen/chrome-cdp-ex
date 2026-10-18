### Bug Fixes

* A named `click` (`text=` or a visible label such as `Save profile`) is now a pointer click that moves focus. The receipt says `Clicked` instead of `JS-clicked`. A target with no usable click box still uses the in-page click and says `(no click box; focus not moved)`. That fallback still reports a followed `URL:`, an opened tab, and `Scroll:` when the resolver scrolled. `jsclick` and `click --js` stay in-page clicks ([#749](https://github.com/EndeavorYen/chrome-cdp-ex/issues/749)).
