export function normalizedEventName(name: string): string {
  return name.normalize("NFKC").trim().replace(/^unity[\s・:：-]*/i, "")
    .replace(/[\s・:：-]/g, "").toLowerCase();
}

// Reception-only similarity: never changes the existing analytical display grouping.
export function similarReceptionEventNames(left:string,right:string):boolean {
 const a0=normalizedEventName(left),b0=normalizedEventName(right);
 if(a0===b0)return !!a0;
 if(JSON.stringify(a0.match(/[\d一二三四五六七八九十百千〇零]+/g)||[])!==JSON.stringify(b0.match(/[\d一二三四五六七八九十百千〇零]+/g)||[]))return false;
 const key=(value:string)=>value.replace(/[【】「」『』（）()［］]/g,'').replace(/[\[\]]/g,'').replace(/(?:交流会|イベント|会)$/,'');
 const a=key(a0),b=key(b0);
 if(a===b)return a.length>=3;
 if(Math.min(a.length,b.length)<4||Math.abs(a.length-b.length)>1)return false;
 let previous=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){
  const current=[i];for(let j=1;j<=b.length;j++)current[j]=Math.min(current[j-1]+1,previous[j]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));previous=current;
 }
 return previous[b.length]<=1&&1-previous[b.length]/Math.max(a.length,b.length)>=.8;
}
