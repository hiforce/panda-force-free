export default {
  title: 'PandaForce Help', tagline: 'A workspace for natural-language work.',
  url: 'https://panda-force.example', baseUrl: '/', trailingSlash: true,
  favicon: 'img/panda-mark.svg', onBrokenLinks: 'throw',
  i18n: {defaultLocale: 'en', locales: ['en', 'zh-Hans'], localeConfigs: {'zh-Hans': {label: '简体中文'}, en: {label: 'English'}}},
  presets: [['classic', {docs: {routeBasePath: '/', sidebarPath: './sidebars.js'}, blog: false, theme: {customCss: './src/css/custom.css'}}]],
  themeConfig: {
    navbar: {title: 'PandaForce Help', logo: {alt: 'PandaForce', src: 'img/panda-mark.svg'}, items: [{type: 'localeDropdown', position: 'right'}]},
    colorMode: {defaultMode: 'light', respectPrefersColorScheme: true},
    footer: {style: 'dark', copyright: 'PandaForce · Best-effort maintenance, no SLA.'},
  },
};
