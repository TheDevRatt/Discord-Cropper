import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { decompressFrames, parseGIF } from "gifuct-js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8AARAwMjDAGsgAAH0QCBY0SMWQAAAAASUVORK5CYII=",
  "base64",
);

const quadrantSvg = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="2" height="2">
    <rect width="1" height="1" x="0" y="0" fill="#ff0000" />
    <rect width="1" height="1" x="1" y="0" fill="#00ff00" />
    <rect width="1" height="1" x="0" y="1" fill="#0000ff" />
    <rect width="1" height="1" x="1" y="1" fill="#ffff00" />
  </svg>
`);

const quadrantGif = Buffer.from(
  "R0lGODlhAgACAPEAAP8AAAD/AAAA////ACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBwABBBAwICAAIfkEAAoAAAAsAAAAAAIAAgCB/wAAAP8AAAD///8ACAcABwgIACAgADs=",
  "base64",
);

async function upload(page: Page, target: string) {
  await page.locator(`input[data-upload="${target}"]`).setInputFiles({
    name: `${target}.png`,
    mimeType: "image/png",
    buffer: tinyPng,
  });
  await expect(page.locator(`input[data-upload="${target}"]`)).toHaveJSProperty(
    "files.length",
    1,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("./");
});

test("text remains readable in light-mode browsers", async ({ page }) => {
  const ratios = await page.evaluate(() => {
    const parse = (value: string) =>
      value
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number);
    const luminance = (rgb: number[]) => {
      const channels = rgb.map((value) => {
        const channel = value / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const contrast = (foreground: Element, background: Element) => {
      const light = luminance(parse(getComputedStyle(foreground).color));
      const dark = luminance(parse(getComputedStyle(background).backgroundColor));
      return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
    };
    return {
      heading: contrast(document.querySelector("h1")!, document.body),
      zoomLabel: contrast(
        document.querySelector(".zoom-control span")!,
        document.querySelector(".profile")!,
      ),
    };
  });
  expect(ratios.heading).toBeGreaterThanOrEqual(4.5);
  expect(ratios.zoomLabel).toBeGreaterThanOrEqual(4.5);
});

test("action labels keep accessible contrast", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"));

  const contrast = (selector: string) =>
    page.locator(selector).first().evaluate((element) => {
      const parse = (value: string) => {
        const channels = value.match(/[\d.]+/g)!.map(Number);
        return [channels[0], channels[1], channels[2], channels[3] ?? 1];
      };
      const luminance = (rgb: number[]) => {
        const channels = rgb.map((value) => {
          const channel = value / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const foreground = parse(getComputedStyle(element).color);
      const background = parse(getComputedStyle(element).backgroundColor);
      const profile = parse(
        getComputedStyle(element.closest(".profile")!).backgroundColor,
      );
      const composited = background.slice(0, 3).map(
        (channel, index) =>
          channel * background[3] + profile[index] * (1 - background[3]),
      );
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(composited);
      return (
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
      );
    });

  for (const colorScheme of ["light", "dark"] as const) {
    await page.mouse.move(0, 0);
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(200);
    await upload(page, "avatar");

    const uploadButton = '.upload-button:not(.download-button)';
    expect(await contrast(uploadButton)).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(".download-button")).toBeGreaterThanOrEqual(4.5);

    await page.locator(uploadButton).first().hover();
    await page.waitForTimeout(200);
    expect(await contrast(uploadButton)).toBeGreaterThanOrEqual(4.5);
  }
});

test("the page never overflows the viewport horizontally", async ({ page }) => {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
});

test("mobile preview uses Safari-safe crop surfaces", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"));

  await expect(page.locator("foreignObject")).toHaveCount(0);

  const banner = page.locator(".profile-banner");
  const avatar = page.locator(".profile-avatar");
  await expect(banner).toBeVisible();
  await expect(avatar).toBeVisible();

  const geometry = await page.evaluate(() => {
    const bannerRect = document
      .querySelector(".profile-banner")!
      .getBoundingClientRect();
    const avatarRect = document
      .querySelector(".profile-avatar")!
      .getBoundingClientRect();
    return {
      bannerRatio: bannerRect.width / bannerRect.height,
      avatarRatio: avatarRect.width / avatarRect.height,
      avatarWidth: avatarRect.width,
      bannerInSvg: Boolean(document.querySelector(".profile-banner")!.closest("svg")),
      avatarInSvg: Boolean(document.querySelector(".profile-picture")!.closest("svg")),
    };
  });

  expect(geometry.bannerInSvg).toBe(false);
  expect(geometry.avatarInSvg).toBe(false);
  expect(geometry.bannerRatio).toBeCloseTo(1100 / 440, 2);
  expect(geometry.avatarRatio).toBeCloseTo(1, 2);
  expect(geometry.avatarWidth).toBeGreaterThanOrEqual(72);
});

test("mobile actions are stacked, full width, and touch sized", async (
  { page },
  testInfo,
) => {
  test.skip(!testInfo.project.name.startsWith("mobile"));

  const actionBox = await page.locator(".upload-actions").boundingBox();
  const buttons = await page.locator(".upload-button").all();
  expect(actionBox).not.toBeNull();

  for (const button of buttons) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(actionBox!.width - 2);
    expect(box!.height).toBeGreaterThanOrEqual(48);
  }

  await expect(page.locator(".crop-help")).toContainText(/pinch/i);
});

test("pasting an image into a crop loads only that section", async ({ page }) => {
  const pasteImage = (selector: string, name: string) =>
    page.locator(selector).evaluate(
      (element, payload) => {
        const bytes = Uint8Array.from(atob(payload.base64), (char) =>
          char.charCodeAt(0),
        );
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([bytes], payload.name, { type: "image/png" }),
        );
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: transfer,
          }),
        );
      },
      { name, base64: tinyPng.toString("base64") },
    );

  const avatarImage = page.locator(".profile-picture img");
  const bannerImage = page.locator(".profile-banner img");
  const initialAvatar = await avatarImage.getAttribute("src");
  const initialBanner = await bannerImage.getAttribute("src");

  await page.locator(".profile-picture").click();
  await expect(page.locator(".profile-picture")).toBeFocused();
  await pasteImage(":focus", "pasted-avatar.png");

  await expect(avatarImage).toHaveAttribute("src", /^blob:/);
  await expect(bannerImage).toHaveAttribute("src", initialBanner!);
  await expect(page.locator('[data-action="download"]')).toBeEnabled();
  await expect(page.locator('input[data-zoom="avatar"]')).toBeEnabled();
  await expect(page.locator('input[data-zoom="banner"]')).toBeDisabled();
  await expect(page.locator('input[data-upload="avatar"]')).toHaveJSProperty(
    "files.length",
    0,
  );

  await page.reload();
  await page.locator(".profile-banner").click();
  await expect(page.locator(".profile-banner")).toBeFocused();
  await pasteImage(":focus", "pasted-banner.png");

  await expect(page.locator(".profile-banner img")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator(".profile-picture img")).toHaveAttribute(
    "src",
    initialAvatar!,
  );
});

test("desktop page paste routes to the selected crop", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"));

  const initialAvatar = await page.locator(".profile-picture img").getAttribute("src");
  const initialBanner = await page.locator(".profile-banner img").getAttribute("src");
  await page.locator(".profile-picture").click();
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "desktop-paste.png", { type: "image/png" }));
    document.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  }, tinyPng.toString("base64"));

  await expect(page.locator(".profile-picture img")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator(".profile-banner img")).toHaveAttribute(
    "src",
    initialBanner!,
  );

  await page.locator(".profile-banner").click();
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "desktop-banner.png", { type: "image/png" }));
    document.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  }, tinyPng.toString("base64"));

  await expect(page.locator(".profile-banner img")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator(".profile-picture img")).toHaveAttribute("src", /^blob:/);
  expect(await page.locator(".profile-picture img").getAttribute("src")).not.toBe(
    initialAvatar,
  );
});

test("desktop page ignores image paste until a crop is selected", async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"));

  const initialAvatar = await page.locator(".profile-picture img").getAttribute("src");
  const initialBanner = await page.locator(".profile-banner img").getAttribute("src");
  const prevented = await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "unselected.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  }, tinyPng.toString("base64"));

  expect(prevented).toBe(false);
  await expect(page.locator(".profile-picture img")).toHaveAttribute(
    "src",
    initialAvatar!,
  );
  await expect(page.locator(".profile-banner img")).toHaveAttribute(
    "src",
    initialBanner!,
  );
  await expect(page.locator('[data-action="download"]')).toBeDisabled();
  await expect(page.locator('input[data-zoom="avatar"]')).toBeDisabled();
  await expect(page.locator('input[data-zoom="banner"]')).toBeDisabled();
});

test("desktop page accepts image clipboard items when files are absent", async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"));

  await page.locator(".profile-picture").click();
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const image = new File([bytes], "clipboard-item.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => image,
          },
        ],
      },
    });
    document.dispatchEvent(event);
  }, tinyPng.toString("base64"));

  await expect(page.locator(".profile-picture img")).toHaveAttribute("src", /^blob:/);
});

test("desktop Ctrl+V pastes a clipboard image into the selected crop", async ({
  context,
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"));

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 4;
    const drawing = canvas.getContext("2d")!;
    drawing.fillStyle = "#b85aff";
    drawing.fillRect(0, 0, 4, 4);
    const image = await new Promise<Blob>((resolve) =>
      canvas.toBlob((blob) => resolve(blob!), "image/png"),
    );
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": image }),
    ]);
  });

  const initialBanner = await page.locator(".profile-banner img").getAttribute("src");
  await page.locator(".profile-picture").click();
  await page.keyboard.press("Control+V");

  await expect(page.locator(".profile-picture img")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator(".profile-banner img")).toHaveAttribute(
    "src",
    initialBanner!,
  );
});

test("non-image clipboard content leaves crops unchanged", async ({ page }) => {
  const initialAvatar = await page.locator(".profile-picture img").getAttribute("src");
  await page.locator(".profile-picture").click();
  const prevented = await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "not an image");
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });

  expect(prevented).toBe(false);
  await expect(page.locator(".profile-picture img")).toHaveAttribute(
    "src",
    initialAvatar!,
  );
  await expect(page.locator('[data-action="download"]')).toBeDisabled();
});

test("flip buttons affect only their matching crop and axis", async ({ page }) => {
  const avatarHorizontal = page.locator(
    'button[data-flip="horizontal"][data-target="avatar"]',
  );
  const avatarVertical = page.locator(
    'button[data-flip="vertical"][data-target="avatar"]',
  );
  const bannerHorizontal = page.locator(
    'button[data-flip="horizontal"][data-target="banner"]',
  );

  await expect(avatarHorizontal).toBeDisabled();
  await expect(avatarVertical).toBeDisabled();
  await expect(bannerHorizontal).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Flip profile picture horizontally" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Flip profile picture vertically" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Flip banner horizontally" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Flip banner vertically" }),
  ).toHaveCount(1);
  await upload(page, "avatar");
  await expect(avatarHorizontal).toBeEnabled();
  await expect(avatarVertical).toBeEnabled();
  await expect(bannerHorizontal).toBeDisabled();

  const avatarImage = page.locator(".profile-picture img");
  const bannerImage = page.locator(".profile-banner img");
  const initialBanner = await bannerImage.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform),
  );

  await avatarHorizontal.click();
  let avatarTransform = await avatarImage.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform),
  );
  expect(avatarTransform.a).toBeLessThan(0);
  expect(avatarTransform.d).toBeGreaterThan(0);
  expect(avatarTransform.e).toBeGreaterThan(0);
  await expect(avatarHorizontal).toHaveAttribute("aria-pressed", "true");

  await avatarVertical.click();
  avatarTransform = await avatarImage.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform),
  );
  expect(avatarTransform.a).toBeLessThan(0);
  expect(avatarTransform.d).toBeLessThan(0);
  expect(avatarTransform.e).toBeGreaterThan(0);
  expect(avatarTransform.f).toBeGreaterThan(0);
  await expect(avatarVertical).toHaveAttribute("aria-pressed", "true");

  await avatarHorizontal.click();
  avatarTransform = await avatarImage.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform),
  );
  expect(avatarTransform.a).toBeGreaterThan(0);
  expect(avatarTransform.d).toBeLessThan(0);
  await expect(avatarHorizontal).toHaveAttribute("aria-pressed", "false");

  const finalBanner = await bannerImage.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform),
  );
  expect(finalBanner.toString()).toBe(initialBanner.toString());

  await upload(page, "avatar");
  await expect(avatarHorizontal).toHaveAttribute("aria-pressed", "false");
  await expect(avatarVertical).toHaveAttribute("aria-pressed", "false");
});

test("zoom and drag stay centered after flipping", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"));

  await upload(page, "avatar");
  const crop = page.locator(".profile-picture");
  const image = crop.locator("img");
  await page
    .locator('button[data-flip="horizontal"][data-target="avatar"]')
    .click();

  const before = await image.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform),
  );
  await crop.hover();
  await page.mouse.wheel(0, -500);
  const zoomed = await image.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform),
  );
  expect(zoomed.a).toBeLessThan(before.a);

  const box = await crop.boundingBox();
  expect(box).not.toBeNull();
  const centerX = box!.x + box!.width / 2;
  const centerY = box!.y + box!.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 30, centerY + 15);
  await page.mouse.up();
  const dragged = await image.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform),
  );
  expect(dragged.e).toBeGreaterThan(zoomed.e + 20);
  expect(dragged.f).toBeGreaterThan(zoomed.f + 10);
});

test("downloaded PNG preserves horizontal and vertical flips", async ({ page }) => {
  await page.locator('input[data-upload="avatar"]').setInputFiles({
    name: "quadrants.svg",
    mimeType: "image/svg+xml",
    buffer: quadrantSvg,
  });
  await page
    .locator('button[data-flip="horizontal"][data-target="avatar"]')
    .click();
  await page
    .locator('button[data-flip="vertical"][data-target="avatar"]')
    .click();

  const pendingDownload = page.waitForEvent("download");
  await page.locator('[data-action="download"]').click();
  const download = await pendingDownload;
  const path = await download.path();
  expect(path).not.toBeNull();

  const zip = await JSZip.loadAsync(await readFile(path!));
  const bytes = await zip.file("avatar.png")!.async("uint8array");
  const corners = await page.evaluate(async (values) => {
    const image = await createImageBitmap(
      new Blob([Uint8Array.from(values)], { type: "image/png" }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const sample = (x: number, y: number) =>
      Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3));
    return {
      topLeft: sample(8, 8),
      topRight: sample(image.width - 9, 8),
      bottomLeft: sample(8, image.height - 9),
      bottomRight: sample(image.width - 9, image.height - 9),
    };
  }, Array.from(bytes));

  expect(corners).toEqual({
    topLeft: [255, 255, 0],
    topRight: [0, 0, 255],
    bottomLeft: [0, 255, 0],
    bottomRight: [255, 0, 0],
  });
});

test("animated GIF exports preserve flips on every frame", async ({ page }) => {
  await page.locator('input[data-upload="avatar"]').setInputFiles({
    name: "quadrants.gif",
    mimeType: "image/gif",
    buffer: quadrantGif,
  });
  await page
    .locator('button[data-flip="horizontal"][data-target="avatar"]')
    .click();
  await page
    .locator('button[data-flip="vertical"][data-target="avatar"]')
    .click();

  const pendingDownload = page.waitForEvent("download");
  await page.locator('[data-action="download"]').click();
  const download = await pendingDownload;
  const path = await download.path();
  expect(path).not.toBeNull();

  const zip = await JSZip.loadAsync(await readFile(path!));
  const output = await zip.file("avatar.gif")!.async("uint8array");
  const parsed = parseGIF(
    output.buffer.slice(
      output.byteOffset,
      output.byteOffset + output.byteLength,
    ) as ArrayBuffer,
  );
  const frames = decompressFrames(parsed, true);
  expect(frames).toHaveLength(2);
  expect([parsed.lsd.width, parsed.lsd.height]).toEqual([512, 512]);

  const rgb = (frame: (typeof frames)[number], x: number, y: number) => {
    const index = (y * frame.dims.width + x) * 4;
    return Array.from(frame.patch.slice(index, index + 3));
  };
  const corners = (frame: (typeof frames)[number]) => ({
    topLeft: rgb(frame, 8, 8),
    topRight: rgb(frame, frame.dims.width - 9, 8),
    bottomLeft: rgb(frame, 8, frame.dims.height - 9),
    bottomRight: rgb(frame, frame.dims.width - 9, frame.dims.height - 9),
  });
  expect(corners(frames[0])).toEqual({
    topLeft: [255, 255, 0],
    topRight: [0, 0, 255],
    bottomLeft: [2, 255, 0],
    bottomRight: [255, 0, 0],
  });
  expect(corners(frames[1])).toEqual({
    topLeft: [255, 0, 0],
    topRight: [2, 255, 0],
    bottomLeft: [0, 0, 255],
    bottomRight: [255, 255, 0],
  });
});

test("mobile zoom controls adjust each uploaded crop", async (
  { page },
  testInfo,
) => {
  test.skip(!testInfo.project.name.startsWith("mobile"));

  for (const target of ["avatar", "banner"]) {
    const control = page.locator(
      `input[type="range"][data-zoom="${target}"]`,
    );
    await expect(control).toBeVisible();
    await expect(control).toBeDisabled();

    await upload(page, target);
    await expect(control).toBeEnabled();
    await page
      .locator(`button[data-flip="horizontal"][data-target="${target}"]`)
      .click();

    const image = page.locator(
      target === "avatar" ? ".profile-picture img" : ".profile-banner img",
    );
    const before = await image.evaluate(
      (element) => new DOMMatrix(getComputedStyle(element).transform).a,
    );
    await control.fill("2");
    const after = await image.evaluate(
      (element) => new DOMMatrix(getComputedStyle(element).transform).a,
    );
    expect(Math.abs(after)).toBeGreaterThan(Math.abs(before) * 1.9);
  }
});

test("one-finger touch drag repositions a zoomed crop", async (
  { page },
  testInfo,
) => {
  test.skip(!testInfo.project.name.startsWith("mobile"));

  await upload(page, "avatar");
  await page.locator('input[data-zoom="avatar"]').fill("2");
  const crop = page.locator(".profile-picture");
  await crop.scrollIntoViewIfNeeded();
  const image = crop.locator("img");
  const box = await crop.boundingBox();
  expect(box).not.toBeNull();
  const before = await image.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform),
  );

  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: x + 40, y: y + 20 }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });

  const after = await image.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform),
  );
  expect(after.e).toBeGreaterThan(before.e + 30);
  expect(after.f).toBeGreaterThan(before.f + 10);
});

test("desktop wheel zoom and mouse drag remain available", async (
  { page },
  testInfo,
) => {
  test.skip(!testInfo.project.name.startsWith("desktop"));

  await upload(page, "avatar");
  const crop = page.locator(".profile-picture");
  const image = crop.locator("img");
  const box = await crop.boundingBox();
  expect(box).not.toBeNull();

  const initial = await image.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform),
  );
  await crop.hover();
  await page.mouse.wheel(0, -400);
  const zoomed = await image.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform),
  );
  expect(zoomed.a).toBeGreaterThan(initial.a * 1.5);
  expect(
    Number(await page.locator('input[data-zoom="avatar"]').inputValue()),
  ).toBeGreaterThan(1.5);

  const centerX = box!.x + box!.width / 2;
  const centerY = box!.y + box!.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 40, centerY + 20);
  await page.mouse.up();
  const dragged = await image.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform),
  );
  expect(dragged.e).toBeGreaterThan(zoomed.e + 30);
  expect(dragged.f).toBeGreaterThan(zoomed.f + 10);
});

test("a two-finger gesture zooms the banner", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"));

  await upload(page, "banner");
  const crop = page.locator(".profile-banner");
  const image = crop.locator("img");
  const box = await crop.boundingBox();
  expect(box).not.toBeNull();

  const before = await image.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform).a,
  );
  const y = box!.y + box!.height / 2;
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: box!.x + box!.width * 0.4, y },
      { x: box!.x + box!.width * 0.6, y },
    ],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: box!.x + box!.width * 0.3, y },
      { x: box!.x + box!.width * 0.7, y },
    ],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });

  const after = await image.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform).a,
  );
  expect(after).toBeGreaterThan(before * 1.5);
});

test("mobile downloads keep Discord's full output dimensions", async (
  { page },
  testInfo,
) => {
  test.skip(!testInfo.project.name.startsWith("mobile"));

  await upload(page, "avatar");
  await upload(page, "banner");
  await expect(page.locator('input[data-zoom="avatar"]')).toBeEnabled();
  await expect(page.locator('input[data-zoom="banner"]')).toBeEnabled();

  const pendingDownload = page.waitForEvent("download");
  await page.locator('[data-action="download"]').click();
  const download = await pendingDownload;
  const path = await download.path();
  expect(path).not.toBeNull();

  const zip = await JSZip.loadAsync(await readFile(path!));
  const dimensions: Record<string, [number, number]> = {};
  for (const name of ["avatar.png", "banner.png"]) {
    const bytes = await zip.file(name)!.async("uint8array");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    dimensions[name] = [view.getUint32(16), view.getUint32(20)];
  }
  expect(dimensions).toEqual({
    "avatar.png": [512, 512],
    "banner.png": [1100, 440],
  });
});

test("mobile-only crop controls stay out of the desktop layout", async (
  { page },
  testInfo,
) => {
  test.skip(!testInfo.project.name.startsWith("desktop"));
  await expect(page.locator(".mobile-crop-controls")).toBeHidden();
});
