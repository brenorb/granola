import { build } from 'vite';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:http';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const directory=await mkdtemp(join(tmpdir(),'granola-key-profile-'));
let browser,server;
try {
  await build({configFile:false,logLevel:'error',plugins:[{
    name:'expose-key-functions-for-benchmark',enforce:'pre',
    transform(code,id) {
      if(!id.endsWith('/src/trade/session-factory.ts'))return;
      if(!code.includes('entropy.privateKey("nostr")') || !code.includes('orderNostrPrivateKey ??'))throw new Error('Run on the order-key experiment branch');
      for(const needle of ['function localKeys(', 'const defaultEntropy:']) {
        if(!code.includes(needle))throw new Error('Benchmark source changed; review instrumentation');
        code=code.replace(needle,'export '+needle);
      }
      return code;
    }
  }],build:{outDir:directory,lib:{entry:resolve('scripts/key-profile-browser.mjs'),formats:['es'],fileName:()=> 'profile.js'}}});
  const script=await readFile(join(directory,'profile.js'));
  server=createServer((req,res)=>{
    if(req.url==='/profile.js'){res.setHeader('Content-Type','text/javascript');res.end(script);}
    else {res.setHeader('Content-Type','text/html');res.end('<script type="module" src="/profile.js"></script>');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext();
  let externalRequests=0;
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){externalRequests++;return route.abort();}return route.continue();});
  const page=await context.newPage();
  await page.exposeFunction('profileProgress',value=>console.log(JSON.stringify(value)));
  await page.goto(origin);
  await page.waitForFunction(()=>typeof window.runKeyProfile==='function');
  const firstUse=[];
  for(let i=0;i<10;i++) {
    const coldContext=await browser.newContext();
    await coldContext.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){externalRequests++;return route.abort();}return route.continue();});
    const coldPage=await coldContext.newPage();
    await coldPage.goto(origin);
    await coldPage.waitForFunction(()=>typeof window.runColdKeyProfile==='function');
    await coldContext.setOffline(true);
    firstUse.push(await coldPage.evaluate(variant=>window.runColdKeyProfile(variant),i%2?'shared':'isolated'));
    await coldContext.close();
  }
  await context.setOffline(true);
  const result=await page.evaluate(()=>window.runKeyProfile());
  if(externalRequests)throw new Error('Unexpected external request');
  const output=process.argv[2] ?? 'key-profile.json';
  await writeFile(output,JSON.stringify({browser:await browser.version(),externalRequests,firstUse,...result},null,2)+'\n');
  console.log(JSON.stringify({output,externalRequests}));
} finally {
  await browser?.close();
  await new Promise(resolve=>server?server.close(resolve):resolve());
  await rm(directory,{recursive:true,force:true});
}
