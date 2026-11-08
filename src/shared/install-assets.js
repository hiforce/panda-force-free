export const HOME_SCREEN_SIZES = [
  [375, 667, 2],
  [414, 736, 3],
  [375, 812, 3],
  [390, 844, 3],
  [393, 852, 3],
  [402, 874, 3],
  [414, 896, 2],
  [414, 896, 3],
  [428, 926, 3],
  [430, 932, 3],
  [440, 956, 3],
];

export const LAUNCH_SCREENS = HOME_SCREEN_SIZES.flatMap(([width, height, scale]) =>
  ["portrait", "landscape"].flatMap((orientation) =>
    ["light", "dark"].map((theme) => ({
      width: (orientation === "portrait" ? width : height) * scale,
      height: (orientation === "portrait" ? height : width) * scale,
      scale,
      theme,
      media: `(device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${scale}) and (orientation: ${orientation}) and (prefers-color-scheme: ${theme})`,
      path: `/assets/panda-launch-${(orientation === "portrait" ? width : height) * scale}x${(orientation === "portrait" ? height : width) * scale}-${theme}.png`,
    })),
  ),
);

export const INSTALL_ASSETS = [
  "/manifest.webmanifest",
  "/assets/panda-touch-180.png",
  "/assets/panda-app-192.png",
  "/assets/panda-app-512.png",
  ...LAUNCH_SCREENS.map((screen) => screen.path),
];
