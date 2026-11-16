/** Fixed worker-owned helpers. Imported projects never supply executable Hexo tag implementations. */
export const semanticHexoTags = `
const escape = (value) => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const markdown = (content) => hexo.render.renderSync({text: content, engine: 'markdown'});
for (const role of ['abstract', 'thesis', 'lead']) {
  hexo.extend.tag.register(role, (args, content) => '<section class="panda-' + role + '">' +
    (role === 'abstract' && args.length ? '<h3>' + escape(args.join(' ')) + '</h3>' : '') + markdown(content) + '</section>', {ends: true});
}
hexo.extend.tag.register('part', args => '<h2>' + escape(args.join(' ')) + '</h2>');
hexo.extend.tag.register('figure', (args, content) => {
  const source = args[0] || '';
  if (!source.startsWith('/assets/') || source.startsWith('//') || /[\\\\\\s<>"']/.test(source)) throw new Error('unsupportedFigureImage');
  const size = [args[2], args[3]].every(v => /^\\d{1,5}$/.test(v || ''))
    ? ' width="' + Number(args[2]) + '" height="' + Number(args[3]) + '"' : '';
  return '<figure><img src="' + escape(hexo.extend.helper.get('url_for').call(hexo, source)) + '" alt="' + escape(args[1]) + '"' + size +
    ' loading="lazy"><figcaption>' + markdown(content) + '</figcaption></figure>';
}, {ends: true});
`;
