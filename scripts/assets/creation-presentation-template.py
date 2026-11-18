# Build-only dependency: python-pptx==1.0.2 in an isolated virtual environment.
# The bundled default presentation is derived from python-pptx's MIT-licensed template.
# See LICENSES/python-pptx-template-MIT.txt; runtime builds do not require Python.
from pathlib import Path
import argparse, zipfile
parser = argparse.ArgumentParser(description="Generate the editable application presentation template")
parser.add_argument("--output", type=Path, required=True, help="Output TypeScript module")
args = parser.parse_args()
from datetime import datetime,timezone
import base64,json,hashlib,io
from pptx import Presentation
import pptx
if pptx.__version__ != '1.0.2':
 raise SystemExit('This build-only generator requires python-pptx==1.0.2 in an isolated virtual environment')
from pptx.util import Inches,Pt
from pptx.dml.color import RGBColor
from pptx.oxml.xmlchemy import OxmlElement
r=Presentation();r.slide_width=Inches(13.333333);r.slide_height=Inches(7.5)
r.core_properties.author='PandaForce';r.core_properties.last_modified_by='PandaForce';r.core_properties.title='PandaForce editable presentation';r.core_properties.created=datetime(2000,1,1,tzinfo=timezone.utc);r.core_properties.modified=datetime(2000,1,1,tzinfo=timezone.utc)
r.slide_master.background.fill.solid();r.slide_master.background.fill.fore_color.rgb=RGBColor.from_string('F8FAFC')
for index,layout in enumerate(r.slide_layouts):
 for shape in layout.placeholders:
  kind=str(shape.placeholder_format.type)
  if not shape.has_text_frame:continue
  if 'TITLE' in kind and 'SUBTITLE' not in kind:
   shape.left=Inches(.8);shape.top=Inches(.65 if index else 2);shape.width=Inches(11.7);shape.height=Inches(1.15 if index else 1.5);size=32 if index else 44
  elif 'BODY' in kind or 'OBJECT' in kind:
   shape.left=Inches(.8);shape.top=Inches(1.9);shape.width=Inches(11.7);shape.height=Inches(4.8);size=24
  elif 'SUBTITLE' in kind:
   shape.left=Inches(.85);shape.top=Inches(3.8);shape.width=Inches(11.6);shape.height=Inches(1.5);size=24
  else:continue
  for paragraph in shape.text_frame.paragraphs:
   paragraph.font.size=Pt(size);paragraph.font.name='Arial';paragraph.font.color.rgb=RGBColor.from_string('102A43')
   for run in paragraph.runs:
    run.font.name='Arial';run.font.size=Pt(size);run.font.color.rgb=RGBColor.from_string('102A43')
  shape.text_frame.clear()
  paragraph=shape.text_frame.paragraphs[0];paragraph.level=0;paragraph.font.name="Arial";paragraph.font.size=Pt(size);paragraph.font.color.rgb=RGBColor.from_string("102A43")
  shape.text_frame.word_wrap=True
  shape.text_frame.margin_left=0;shape.text_frame.margin_right=0;shape.text_frame.margin_top=0;shape.text_frame.margin_bottom=0
  for paragraph in shape.text_frame.paragraphs:paragraph.space_before=Pt(0);paragraph.space_after=Pt(8);paragraph.line_spacing=1.12
  if index==8 and shape.shape_id==4:shape.width=Inches(5.5)
 for shape in layout.placeholders:
  if index==8 and shape.shape_id==3:shape.left=Inches(6.8);shape.top=Inches(1.9);shape.width=Inches(5.5);shape.height=Inches(4.8)
accent=OxmlElement('p:sp')
accent_xml='''<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:nvSpPr><p:cNvPr id="1001" name="PandaForce Accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12191999" cy="64008"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="127786"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>'''
from lxml import etree
r.slide_master.shapes._spTree.append(etree.fromstring(accent_xml.encode()))
slide=r.slides.add_slide(r.slide_layouts[0]);slide.shapes.title.text='PandaForce';slide.placeholders[1].text='Editable presentation'
out=io.BytesIO();r.save(out)
normalized=io.BytesIO()
with zipfile.ZipFile(out) as original, zipfile.ZipFile(normalized, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as result:
 for name in sorted(original.namelist()):
  entry=zipfile.ZipInfo(name, date_time=(2000,1,1,0,0,0));entry.compress_type=zipfile.ZIP_DEFLATED
  result.writestr(entry,original.read(name),compresslevel=9)
b=normalized.getvalue()
encoded=base64.b64encode(b).decode();lines=[encoded[i:i+120] for i in range(0,len(encoded),120)];source='// Application presentation template generated with python-pptx 1.0.2 (MIT); native layout content stays editable.\nconst source = [\n'+''.join('  "'+line+'",\n' for line in lines)+'].join("");\n\nexport function defaultPresentationBytes(): Uint8Array {\n  return new Uint8Array(Buffer.from(source, "base64"));\n}\n';args.output.write_text(source)
print(json.dumps({'sha256': hashlib.sha256(b).hexdigest(), 'bytes': len(b), 'output': str(args.output)}))
