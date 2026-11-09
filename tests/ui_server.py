"""Manual UI validation using real node scripts/routes and disposable CSV files."""
import argparse
import codecs
import uuid
from pathlib import Path
from aiohttp import web
from support import NODE_DIR, load_node


HTML = r'''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>CSV 编辑器隔离测试</title>
<style>body{margin:36px;background:#111318;color:#ddd;font:15px sans-serif}button{background:#2b3340;color:#eee;border:1px solid #555;padding:10px;border-radius:7px;cursor:pointer}pre{background:#1d212a;padding:16px;white-space:pre-wrap;line-height:1.7}canvas{border:1px solid #555;border-radius:10px;margin:16px 0}#errors{color:#ffabab}</style>
<h1>CSV 编辑器 · 隔离测试</h1><p>使用真实节点脚本和保存接口，所有写入仅位于临时测试目录。</p>
<div id="buttons"></div><canvas width="420" height="340"></canvas><h3>两个引用同一 CSV 的节点预览</h3><pre id="preview">加载中…</pre><pre id="errors"></pre>
<script>
window.addEventListener('error', e => {document.getElementById('errors').textContent += e.message + '\n';});
window.addEventListener('unhandledrejection', e => {document.getElementById('errors').textContent += String(e.reason) + '\n';});
window.LiteGraph = {WIDGET_TEXT_COLOR:'#ddd'};
window.bootCsvNode = async (extension, app) => {
  const canvas=document.querySelector('canvas'), ctx=canvas.getContext('2d');
  let ready=false;
  const nodes=[];
  function render() {
    if(!ready) return;
    ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#202024';ctx.fillRect(0,0,420,340);ctx.font='13px sans-serif';
    let y=12;
    for(const w of nodes[0].widgets) {w._testY=y;w.draw?.(ctx,nodes[0],420,y);y+=(w.computeSize?.()[1]??32)+4;}
    document.getElementById('preview').textContent=nodes.map((n,i)=>{
      const row=n.widgets.find(w=>w.value?.type==='CsvRowWidget');
      return `节点 ${i+1}: ${row?._getSelPreviewText()} → ${row?._getOutPreview()}`;
    }).join('\n');
  }
  for(let i=0;i<2;i++) {
    const n={comfyClass:'CSV_MultiLangPromptPicker',widgets:[],size:[420,300],properties:{},
      addCustomWidget(w){this.widgets.push(w);return w;},
      addWidget(type,name,value,callback){const w={type,name,value,callback};this.widgets.push(w);if(!i){const b=document.createElement('button');b.textContent=name;b.onclick=callback;document.getElementById('buttons').append(b);}return w;},
      configure(info){this.properties=info.properties||{};},computeSize(){return[420,300];},setDirtyCanvas(){if(ready)requestAnimationFrame(render);}};
    nodes.push(n); app.graph._nodes.push(n); await extension.nodeCreated(n);
    n.configure({properties:{vslinx_csv_rows:[{type:'CsvRowWidget',file:'demo.csv',key:i?['电影灯光','窗边日光']:'电影灯光',keys:i?['电影灯光','窗边日光']:[],order:0,join_comma:true}]}});
  }
  canvas.addEventListener('pointerdown',event=>{
    const r=canvas.getBoundingClientRect(),pos=[(event.clientX-r.left)*canvas.width/r.width,(event.clientY-r.top)*canvas.height/r.height];
    for(const w of nodes[0].widgets){const h=w.computeSize?.()[1]??32;if(pos[1]>=w._testY&&pos[1]<=w._testY+h)w.mouse?.(event,pos,nodes[0]);}render();
  });
  ready=true;render();
};
</script><script type="module" src="/extensions/csv_prompt_picker1.js"></script></html>'''

APP_JS = '''export const app = {
 graph:{_nodes:[]},canvas:{canvas:document.querySelector('canvas'),processMouseMove(){}},
 extensionManager:{toast:{add(message){document.getElementById('errors').textContent=message.summary+': '+message.detail;}}},
 registerExtension(extension){window.bootCsvNode(extension,this);}
};'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8199)
    args = parser.parse_args()
    root = NODE_DIR / ".test-tmp" / ("csv-editor-ui-" + uuid.uuid4().hex[:8])
    (root / "csv").mkdir(parents=True)
    (root / "csv/demo.csv").write_bytes(codecs.BOM_UTF8 + '电影灯光,"soft cinematic light, warm tones",保留额外列\r\n窗边日光,natural window light,备注\r\n单列提示词\r\n电影灯光,"soft cinematic light, warm tones",重复标签保留\r\n'.encode())
    _, app = load_node(root)

    async def index(request):
        return web.Response(text=HTML, content_type="text/html")

    async def app_js(request):
        return web.Response(text=APP_JS, content_type="text/javascript")

    async def api_js(request):
        return web.Response(text="export const api={fetchApi:(route,options)=>fetch(route,options)};", content_type="text/javascript")

    app.router.add_get("/", index)
    app.router.add_get("/scripts/app.js", app_js)
    app.router.add_get("/scripts/api.js", api_js)
    app.router.add_static("/extensions/", NODE_DIR / "web/js")
    app.on_response_prepare.append(no_cache)
    print(f"Disposable test data: {root}", flush=True)
    web.run_app(app, host="127.0.0.1", port=args.port, access_log=None)


async def no_cache(request, response):
    response.headers["Cache-Control"] = "no-store"


if __name__ == "__main__":
    main()
