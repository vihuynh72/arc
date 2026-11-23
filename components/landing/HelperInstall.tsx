"use client";
// The install steps for the Arc helper (extension/), or a line saying it is already installed: the helper's content script marks
// Arc's own pages (lib/client/helper.ts helperId), which only a browser can see, so this is the one client piece of
// components/Landing.tsx. The server render and the first client render show the steps, so nothing differs at hydration.
import { useSyncExternalStore } from "react";
import { helperId } from "@/lib/client/helper";

const REPO = "https://github.com/vihuynh72/arc";

function Keys() {
  return (
    <>
      <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>A</kbd> (<kbd>Option</kbd> <kbd>Shift</kbd> <kbd>A</kbd> on a Mac)
    </>
  );
}

export default function HelperInstall({ storeUrl }: { storeUrl: string }) {
  const installed = useSyncExternalStore(
    () => () => {},
    () => !!helperId(),
    () => false,
  );

  if (installed)
    return (
      <p className="lp-helper-on" role="status">
        The helper is installed. Press <Keys /> on any page.
      </p>
    );

  return (
    <>
      {storeUrl ? (
        <p>
          <a className="lp-add" href={storeUrl}>
            Add to Chrome
          </a>
        </p>
      ) : (
        <>
          <p className="lp-helper-note">The Chrome Web Store listing is not published yet. Until it is, add the helper by hand:</p>
          <ol className="lp-helper-steps">
            <li>
              Download Arc from <a href={REPO}>its GitHub page</a> (Code, then Download ZIP) and unzip it. The helper is the <a href={`${REPO}/tree/main/extension`}>extension folder</a>.
            </li>
            <li>
              In Chrome, open <code>chrome://extensions</code>.
            </li>
            <li>Turn on Developer mode, at the top right.</li>
            <li>Choose Load unpacked, then pick the extension folder.</li>
            <li>
              Press <Keys /> on any page.
            </li>
          </ol>
        </>
      )}
      <p className="lp-helper-note">
        No install? Arc also has a bookmark that sends the page the same way. <a href={`${REPO}/blob/main/docs/private-pages.md`}>How to make it</a>.
      </p>
    </>
  );
}
