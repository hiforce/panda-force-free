import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACHMENT_MAX_BYTES, saveAttachment } from '../src/server/workspace/attachments.js';
import { attachmentsFromInput, buildComposerInput, composerInputKey, composerTextFromInput, filesFromClipboard } from '../src/client/composer-attachments.js';
import { createComposerHistory } from '../src/client/ui-core.js';

const png=readFileSync(new URL('../public/assets/panda-icon.png',import.meta.url));
const request=(bytes,headers={})=>Object.assign((async function*(){yield bytes})(),{headers});

test('uploads use isolated names and retain validated image bytes and private permissions', async () => {
  const root=mkdtempSync(join(tmpdir(),'webui-upload-'));
  try {
    const first=await saveAttachment(request(png),root,'../../截图.png');
    const second=await saveAttachment(request(png),root,'截图.png');
    expect(first.name).toBe('截图.png');expect(first.kind).toBe('image');
    expect(first.path.startsWith(root+'/')).toBe(true);expect(first.path).not.toBe(second.path);
    expect(readFileSync(first.path)).toEqual(png);
    expect(statSync(first.path).mode&0o777).toBe(0o600);
    const file=await saveAttachment(request(Buffer.from('notes')),root,'notes.txt');
    expect(file.kind).toBe('file');expect(file.size).toBe(5);
  } finally {rmSync(root,{recursive:true,force:true})}
});

test('empty, oversized, aborted and disguised image uploads do not leave files', async () => {
  const root=mkdtempSync(join(tmpdir(),'webui-upload-reject-'));
  try {
    await expect(saveAttachment(request(Buffer.alloc(0)),root,'empty.txt')).rejects.toThrow('empty');
    await expect(saveAttachment(request(Buffer.from('invalid')),root,'fake.png')).rejects.toThrow('file type');
    await expect(saveAttachment(request(Buffer.from('small'),{'content-length':ATTACHMENT_MAX_BYTES+1}),root,'large.txt')).rejects.toThrow('25 MiB');
    await expect(saveAttachment(request(Buffer.alloc(ATTACHMENT_MAX_BYTES+1)),root,'large.txt')).rejects.toThrow('25 MiB');
    await expect(saveAttachment(request(png),root,'..')).rejects.toThrow('filename');
    const aborted=(async function*(){yield png;throw new Error('aborted')})();
    await expect(saveAttachment(aborted,root,'aborted.png')).rejects.toThrow('aborted');
    expect(readdirSync(root)).toEqual([]);
  } finally {rmSync(root,{recursive:true,force:true})}
});

test('image-only history and mixed file/image input retain their attachment identity', () => {
  const attachments=[{id:'a',name:'image.png',path:'/uploads/image.png',kind:'image',status:'ready'},{id:'b',name:'notes.txt',path:'/uploads/notes.txt',kind:'file',status:'ready'}];
  const input=buildComposerInput('Review these',attachments);
  expect(input[1]).toEqual({type:'localImage',path:'/uploads/image.png'});
  expect(attachmentsFromInput(input).map(value=>[value.kind,value.path])).toEqual(attachments.map(value=>[value.kind,value.path]));
  expect(composerTextFromInput(input)).toBe('Review these');
  const merged=[{type:'text',text:input.filter(part=>part.type==='text').map(part=>part.text).join('\n')}];
  expect(composerTextFromInput(merged)).toBe('Review these');
  expect(attachmentsFromInput(merged)[0].name).toBe('notes.txt');
  expect(composerInputKey(buildComposerInput('',[attachments[0]]))).not.toBe(composerInputKey(buildComposerInput('',[{...attachments[0],path:'/different.png'}])));
  const history=createComposerHistory();history.record({text:'',attachments:[attachments[0]]});
  const recalled=history.navigate(-1,'',0);expect(recalled.attachments).toEqual([attachments[0]]);
  recalled.attachments[0].path='/mutated';history.reset();
  expect(history.navigate(-1,'',0).attachments[0].path).toBe('/uploads/image.png');
  expect(history.navigate(1,'',0)?.text).toBe('');
});

test('clipboard files and items retain named files, avoid duplicates and name only nameless image blobs', async () => {
  const file = new File([png], '剪贴板截图', { type: 'image/png' });
  const items = [{ kind: 'string' }, { kind: 'file', getAsFile: () => file }, { kind: 'file', getAsFile: () => null }];
  expect(filesFromClipboard({ files: [file], items })).toEqual([file]);
  expect(filesFromClipboard({ files: [], items })).toEqual([file]);
  expect(filesFromClipboard({ items })).toEqual([file]);
  expect(filesFromClipboard({ files: [], items: [{ kind: 'string' }] })).toEqual([]);
  expect(filesFromClipboard(null)).toEqual([]);
  const [named] = filesFromClipboard({ files: [new File([png], '', { type: 'image/png' })] }, { now: () => new Date('2026-11-03T09:40:12.345Z') });
  expect(named.name).toBe('clipboard-20261103T094012345Z-1.png');
  expect(named.type).toBe('image/png');
  expect(Buffer.from(await named.arrayBuffer())).toEqual(png);
});

test('extensionless clipboard images enter visual input with the original filename', async () => {
  const root = mkdtempSync(join(tmpdir(), 'webui-clipboard-upload-'));
  try {
    const attachment = await saveAttachment(request(png), root, '剪贴板截图');
    expect(attachment.name).toBe('剪贴板截图');
    expect(attachment.kind).toBe('image');
    expect(attachment.contentType).toBe('image/png');
    expect(readFileSync(attachment.path)).toEqual(png);
    expect(buildComposerInput('Read the pasted image', [attachment])[1]).toEqual({ type: 'localImage', path: attachment.path });
    const transcoded = await saveAttachment(request(png), root, '原照片.jpg');
    expect(transcoded).toMatchObject({ name: '原照片.jpg', kind: 'image', contentType: 'image/png' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
