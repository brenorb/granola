import { localKeys, defaultEntropy } from '../src/trade/session-factory.ts';
import { MakerIdentity } from '../src/nostr/identity.ts';
import { IndexedDbStorageDriver } from '../src/storage/wallet-repository.ts';
import { withWalletLock } from '../src/browser/lock.ts';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const percentile = (xs, p) => [...xs].sort((a,b)=>a-b)[Math.floor((xs.length-1)*p)];
const stats = xs => ({ samples:xs.length, medianMs:percentile(xs,.5), p95Ms:percentile(xs,.95), meanMs:xs.reduce((a,b)=>a+b,0)/xs.length });
const check = keys => {
  if(keys.nostrPubkey.length!==64 || new Set([keys.nostrPrivateKey,keys.cashuPrivateKey,keys.refundPrivateKey]).size!==3) throw new Error('Key generation invariant failed');
};

window.runColdKeyProfile = variant => {
  const orderHex=hex(generateSecretKey());
  const start=performance.now();
  const keys=localKeys(defaultEntropy,variant==='shared'?orderHex:undefined);
  const elapsedMs=performance.now()-start;
  check(keys);performance.clearMeasures();
  return {variant,elapsedMs};
};

window.runKeyProfile = async () => {
  const orderKey = generateSecretKey();
  const orderHex = hex(orderKey);
  const isolated = () => localKeys(defaultEntropy);
  const reused = () => localKeys(defaultEntropy,orderHex);
  const result = { offline:navigator.onLine===false, operationsPerSample:10, rounds:[], access:[], primitives:{} };
  if(!result.offline) throw new Error('Benchmark must run offline');
  // Alternating pair order limits drift/JIT bias. Warm both paths before recording.
  for(let i=0;i<100;i++){check(isolated());check(reused());performance.clearMeasures();}
  for(let round=0;round<5;round++) {
    const a=[],b=[],savings=[];
    for(let i=0;i<200;i++) {
      let ta,tb;
      for(const variant of (i%2 ? ['b','a']:['a','b'])) {
        const start=performance.now();
        let keys;
        for(let j=0;j<10;j++)keys=variant==='a'?isolated():reused();
        const elapsed=(performance.now()-start)/10;
        check(keys);
        if(variant==='a')ta=elapsed;else tb=elapsed;
        performance.clearMeasures();
      }
      a.push(ta);b.push(tb);savings.push(ta-tb);
    }
    result.rounds.push({isolated:stats(a),reuseInMemory:stats(b),pairedSavingMs:stats(savings)});
    await window.profileProgress({phase:'keys',round:round+1});
  }
  const primitives = {
    randomAndHex:()=>hex(generateSecretKey()),
    nostrPublicDerivation:()=>getPublicKey(orderKey)
  };
  for(const [name,fn] of Object.entries(primitives)) {
    for(let i=0;i<100;i++)fn();
    const batches=[];
    for(let i=0;i<100;i++) {
      const start=performance.now();
      for(let j=0;j<50;j++)if(fn().length!==64)throw new Error('Invalid key length');
      batches.push((performance.now()-start)/50);
    }
    result.primitives[name]={...stats(batches),operationsPerBatch:50};
  }
  // Actual order-key access uses IndexedDB + Web Lock + validation of the stored map.
  for(const count of [1,10,100]) {
    const profile=`key-profile-${count}`;
    const driver=new IndexedDbStorageDriver(profile);
    const identity=new MakerIdentity(driver,action=>withWalletLock(profile,action));
    const keys={};let id;
    for(let i=0;i<count;i++){id=crypto.randomUUID();keys[id]=hex(generateSecretKey());}
    await driver.set('granola.nostr.order-keys.v1',{version:1,keys});
    const access=()=>identity.useOrderSecretKey(id,async key=>key.length);
    const complete=()=>identity.useOrderSecretKey(id,async key=>localKeys(defaultEntropy,hex(key)));
    for(let i=0;i<20;i++){await access();check(await complete());performance.clearMeasures();}
    const reads=[],a=[],b=[],savings=[];
    for(let i=0;i<100;i++) {
      let ta,tb;
      for(const variant of (i%2?['b','a']:['a','b'])) {
        const start=performance.now();
        const keys=variant==='a'?isolated():await complete();
        const elapsed=performance.now()-start;
        check(keys);if(variant==='a')ta=elapsed;else tb=elapsed;
        performance.clearMeasures();
      }
      const start=performance.now();
      if(await access()!==32)throw new Error('Invalid order key');
      reads.push(performance.now()-start);a.push(ta);b.push(tb);savings.push(ta-tb);
    }
    result.access.push({storedOrders:count,readAndValidate:stats(reads),isolated:stats(a),reuseWithOrderRead:stats(b),pairedSavingMs:stats(savings)});
    await driver.delete('granola.nostr.order-keys.v1');
    await window.profileProgress({phase:'storage',orders:count});
  }
  orderKey.fill(0);
  return result;
};
