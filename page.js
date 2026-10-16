// Injected into a tab (top frame, the extension's isolated world) right before a command uses it.
// Defines globalThis.__zyraena; background.js calls its functions by name. Re-injecting just
// redefines them; the stores of half-finished transfers survive that.
//
// Elements are addressed by the numbers readPage writes into a data-zyraena-ref attribute, so
// Zyraena can say "click 12". (WhatsApp isn't read here any more: Zyraena uses WhatsApp Desktop.)

(() => {
  const REF = "data-zyraena-ref";
  const blobs = (globalThis.__zyraenaBlobs ||= {}); // key -> Blob being read out by Zyraena
  const uploads = (globalThis.__zyraenaUploads ||= {}); // key -> [Uint8Array] being sent by Zyraena

  const clean = (text, max) => (text || "").replace(/\s+/g, " ").trim().slice(0, max);

  function byRef(ref) {
    const el = document.querySelector(`[${REF}="${CSS.escape(String(ref))}"]`);
    if (!el) throw new Error(`element ${ref} isn't on the page any more; read the page again`);
    return el;
  }

  function visible(el) {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }

  function labelOf(el) {
    const tag = el.tagName;
    return clean(
      el.getAttribute("aria-label") ||
        (el.labels?.[0]?.innerText) ||
        (tag === "SELECT" ? el.selectedOptions[0]?.text : "") ||
        (tag === "SELECT" || tag === "TEXTAREA" ? "" : el.innerText) ||
        (el.tagName === "INPUT" && el.type !== "password" ? el.value : "") ||
        el.placeholder ||
        el.title ||
        el.alt ||
        el.querySelector?.("img[alt]")?.alt ||
        el.name ||
        "",
      80,
    );
  }

  function kindOf(el) {
    const tag = el.tagName;
    if (tag === "IMG") return "image";
    if (tag === "VIDEO") return "video";
    if (!el.matches(CONTROLS) && el.matches(DROP_ZONES)) return "drop area";
    if (tag === "A") return "link";
    if (tag === "SELECT") return "dropdown";
    if (tag === "TEXTAREA") return "field";
    if (tag === "INPUT") {
      const type = (el.type || "text").toLowerCase();
      if (type === "file") return "file input";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (["checkbox", "radio"].includes(type)) return `${type}${el.checked ? " (on)" : ""}`;
      return `field (${type})`;
    }
    if (el.isContentEditable) return "text box";
    return el.getAttribute("role") || (tag === "BUTTON" ? "button" : tag.toLowerCase());
  }

  // Real-looking mouse events, then click(): some sites react to mousedown, others to click.
  function press(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    const box = el.getBoundingClientRect();
    const at = {
      bubbles: true, cancelable: true, composed: true, button: 0, view: window,
      clientX: box.left + box.width / 2, clientY: box.top + box.height / 2,
    };
    const pointer = { ...at, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", pointer));
    el.dispatchEvent(new MouseEvent("mousedown", at));
    el.focus?.({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerup", pointer));
    el.dispatchEvent(new MouseEvent("mouseup", at));
    el.click();
  }

  function pressKey(el, name) {
    const init = { key: name, code: name, bubbles: true, cancelable: true, composed: true };
    for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, init));
  }

  function keepBlob(blob, key, name) {
    blobs[key] = blob;
    return { key, size: blob.size, type: blob.type, name: name || "" };
  }

  const CONTROLS =
    'a[href], button, input:not([type="hidden"]), textarea, select, summary, [contenteditable=""], ' +
    '[contenteditable="true"], [role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
    '[role="checkbox"], [role="option"], [role="textbox"]';
  const DROP_ZONES = '[aria-label*="drop" i], [class*="dropzone" i], [class*="drop-zone" i], [data-testid*="drop" i]';
  const ELEMENTS = `${CONTROLS}, ${DROP_ZONES}, img, video`;

  globalThis.__zyraena = {
    // Title, address, visible text, and the elements Zyraena can use, numbered: links, buttons,
    // fields, drop areas, and pictures/videos (to download).
    readPage(maxText, maxElements) {
      for (const el of document.querySelectorAll(`[${REF}]`)) el.removeAttribute(REF);
      const elements = [];
      let skipped = 0;
      for (const el of document.querySelectorAll(ELEMENTS)) {
        const fileInput = el.matches('input[type="file"]'); // usually hidden behind a styled button
        if (!fileInput && !visible(el)) continue;
        const media = el.matches("img, video");
        if (media && Math.min(el.getBoundingClientRect().width, el.getBoundingClientRect().height) < 40) continue;
        if (!fileInput && !media && !el.matches("input, textarea, select") && el.parentElement?.closest(CONTROLS)) continue;
        if (elements.length >= maxElements) {
          skipped += 1;
          continue;
        }
        const ref = String(elements.length + 1);
        el.setAttribute(REF, ref);
        const href = el.tagName === "A" && typeof el.href === "string" ? el.href : "";
        elements.push({ ref, kind: kindOf(el), label: labelOf(el), href });
      }
      const text = clean(document.body?.innerText, maxText);
      return {
        title: document.title, url: location.href, text,
        textCut: (document.body?.innerText || "").length > maxText, elements, skipped,
      };
    },

    describe(ref) {
      const el = byRef(ref);
      return { kind: kindOf(el), label: labelOf(el) };
    },

    // A link that opens a new window is returned instead (background.js opens it as a tab:
    // a script's click would be stopped by the popup blocker).
    click(ref) {
      const el = byRef(ref);
      const link = el.closest("a[href]");
      if (link && link.target === "_blank" && /^https?:/i.test(link.href)) return { openUrl: link.href };
      press(el);
      return { clicked: labelOf(el) };
    },

    type(ref, text, submit) {
      const el = byRef(ref);
      el.scrollIntoView({ block: "center" });
      el.focus();
      if (el.tagName === "SELECT") {
        const options = [...el.options];
        const wanted = text.trim().toLowerCase();
        const option =
          options.find((o) => o.text.trim().toLowerCase() === wanted) ||
          options.find((o) => o.text.toLowerCase().includes(wanted));
        if (!option) throw new Error(`no such option; the options are: ${options.map((o) => o.text.trim()).join(", ")}`);
        el.value = option.value;
      } else if (el.isContentEditable) {
        document.execCommand("selectAll");
        document.execCommand("insertText", false, text);
      } else if ("value" in el) {
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      } else {
        throw new Error("that element doesn't take text");
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (submit) {
        if (el.form) el.form.requestSubmit();
        else pressKey(el, "Enter");
      }
      return true;
    },

    // What a download of this element means: an http(s) address the browser downloads, or the
    // element's media held in memory (blob:/data:) for Zyraena to read out with blobChunk.
    async media(ref, key) {
      const el = byRef(ref);
      const source = el.matches("img, video, audio, a, source") ? el : el.querySelector("video, img, audio, a[href]");
      const src = source && (source.currentSrc || source.src || source.href);
      if (!src) throw new Error("that element has no file or picture to download");
      const name = el.getAttribute("download") || source.getAttribute?.("download") || "";
      if (/^https?:/i.test(src)) return { url: src, name };
      if (!/^(blob|data):/i.test(src)) throw new Error("that element's file can't be downloaded");
      return keepBlob(await (await fetch(src)).blob(), key, name);
    },

    // One base64 piece of a kept blob.
    blobChunk(key, offset, length) {
      const blob = blobs[key];
      if (!blob) throw new Error("the file isn't in memory any more");
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob.slice(offset, offset + length));
      });
    },

    releaseBlob(key) {
      delete blobs[key];
      return true;
    },

    // Receives a file from Zyraena in base64 pieces...
    uploadChunk(key, data) {
      const bytes = atob(data);
      const part = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) part[i] = bytes.charCodeAt(i);
      (uploads[key] ||= []).push(part);
      return true;
    },

    // ...and hands it to the page: set on a file input, or dropped on a drop zone.
    uploadFinish(key, ref, name, type) {
      const parts = uploads[key];
      delete uploads[key];
      if (!parts) throw new Error("the file didn't arrive");
      const el = byRef(ref);
      const transfer = new DataTransfer();
      transfer.items.add(new File(parts, name, { type: type || "application/octet-stream" }));
      const input = el.matches('input[type="file"]') ? el : el.querySelector('input[type="file"]');
      if (input) {
        input.files = transfer.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return { method: "file input" };
      }
      el.scrollIntoView({ block: "center" });
      for (const type of ["dragenter", "dragover", "drop"]) {
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer }));
      }
      return { method: "dropped on the element" };
    },
  };
})();
