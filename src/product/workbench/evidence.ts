const DATE = '(?:(\\d{4})[年./-](\\d{1,2})[月./-](\\d{1,2})日?|(\\d{1,2})月(\\d{1,2})日)';

function dates(text:string){
  return [...text.matchAll(new RegExp(DATE,'gu'))].flatMap(match=>{
    const year=match[1]?Number(match[1]):undefined;
    const month=Number(match[2]??match[4]),day=Number(match[3]??match[5]),y=year??2000;
    const days=[31,y%400===0||y%4===0&&y%100!==0?29:28,31,30,31,30,31,31,30,31,30,31];
    return month>=1&&month<=12&&day>=1&&day<=days[month-1]! ? [{year,month,day,raw:match[0]}]:[];
  });
}

export function workbenchEvidenceWindow(content:string,question:string,snippet:string):{start:number;end:number;fromEnd:boolean;eventDate?:string;eventOffset?:number}{
  const requested=dates(question);
  const fromEnd=/较后|最后(?:一段|一版|一条)|末段/.test(question);
  if(requested.length){
    const events=[...content.matchAll(new RegExp(`^[\\t ]*(?:#{1,6}[\\t ]*|[-*][\\t ]+)?(${DATE})`,'gmu'))].flatMap(match=>{
      const date=dates(match[1]!)[0];return date?[{...date,start:match.index!}]:[];
    });
    for(const asked of requested){
      const matching=events.filter(event=>event.month===asked.month&&event.day===asked.day&&(asked.year===undefined||event.year===asked.year));
      if(asked.year===undefined&&new Set(matching.map(event=>event.year)).size>1)continue;
      const event=fromEnd?matching.at(-1):matching[0];
      if(event){
        const index=events.indexOf(event);
        return {start:event.start,end:events[index+1]?.start??content.length,fromEnd,eventDate:event.raw,eventOffset:event.start};
      }
    }
  }
  const needle=snippet.replace(/\s/gu,'');
  if(needle.length>=12){
    const positions:number[]=[];let normalized='';
    for(let i=0;i<content.length;i++)if(!/\s/u.test(content[i]!)){normalized+=content[i];positions.push(i);}
    const found=normalized.indexOf(needle);
    if(found>=0)return {start:Math.max(0,positions[found]!-160),end:content.length,fromEnd:false};
  }
  return {start:0,end:content.length,fromEnd:false};
}
