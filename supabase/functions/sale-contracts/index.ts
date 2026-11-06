import { createClient } from "npm:@supabase/supabase-js@2.49.8";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const url = Deno.env.get("SUPABASE_URL") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
const site = (Deno.env.get("PUBLIC_APP_URL") || "https://limaribeiroabraaolimaribeiro-afk.github.io/Smart-Billingg").replace(/\/+$/, "");
const bucket = "sale-contracts-private";
const admin = createClient(url, serviceKey);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store"
};
const reply = (data: unknown, status=200) => new Response(JSON.stringify(data), {status, headers: {...CORS, "Content-Type":"application/json; charset=utf-8"}});
const plain = (v: unknown, limit=180) => typeof v === "string" ? v.trim().slice(0,limit) : "";
const emailOK = (e:string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length<=180;
const digits = (s:string) => s.replace(/\D/g,"");
function cpfOK(value:string):boolean {
  const v=digits(value);
  if(v.length!==11 || /^(\d)\1+$/.test(v))return false;
  for(let size=9;size<=10;size++){
    const sum=v.slice(0,size).split("").reduce((a,b,i)=>a+Number(b)*(size+1-i),0);
    const check=(sum*10)%11%10;
    if(check!==Number(v[size]))return false;
  }
  return true;
}
const sigOK = (x:string) => /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(x) && x.length>350 && x.length<350000;
const sigBytes = (x:string) => Uint8Array.from(atob(x.split(",")[1]),c=>c.charCodeAt(0));
const hex = async(bytes:Uint8Array|string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256",typeof bytes==="string"?new TextEncoder().encode(bytes):bytes))].map(x=>x.toString(16).padStart(2,"0")).join("");
function monthDates(first:string):string[] {
  const [year,month,day]=first.split("-").map(Number);
  return Array.from({length:10},(_,i)=>{
    const d=new Date(Date.UTC(year,month-1+i,1));
    const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
    d.setUTCDate(Math.min(day,last));
    return d.toISOString().slice(0,10);
  });
}
const dateBR = (v:string) => v.split("-").reverse().join("/");
const money = (v:number) => new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(v);
const pdfSafe = (v:unknown) => String(v||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^\x20-\x7E]/g,"-");
async function createPDF(c:any):Promise<Uint8Array>{
  const pdf=await PDFDocument.create();
  const regular=await pdf.embedFont(StandardFonts.Helvetica);
  const bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  let page=pdf.addPage([595.28,841.89]);let y=800;
  const line=(value:string,size=10,isBold=false,gap=5)=>{
    const font=isBold?bold:regular;const words=pdfSafe(value).split(/\s+/);let row="";
    const draw=(v:string)=>{
      if(y<92){page=pdf.addPage([595.28,841.89]);y=800;}
      page.drawText(v,{x:47,y,size,font,color:rgb(.12,.15,.23)});y-=size+gap;
    };
    for(const word of words){const check=row?row+" "+word:word;
      if(font.widthOfTextAtSize(check,size)>500 && row){draw(row);row=word;}else row=check;
    }if(row)draw(row);
  };
  const space=(n=8)=>{y-=n;};
  line("CONTRATO PARTICULAR DE COMPRA E VENDA DE NOTEBOOK",15,true,10);
  line("Documento eletronico - compra parcelada via Pix",10);space(8);
  line("VENDEDOR",12,true);
  line("Nome: "+c.seller_name);line("CPF: "+c.seller_cpf);
  line("Endereco: "+c.seller_address);line("E-mail: "+c.seller_email);space();
  line("COMPRADORA",12,true);
  line("Nome: "+c.buyer_name);line("CPF: "+c.buyer_cpf);
  line("Endereco: "+c.buyer_address);line("E-mail: "+c.buyer_email);
  line("Telefone: "+(c.buyer_phone||"Nao informado"));space();
  line("BEM VENDIDO",12,true);
  line("Descricao: "+c.product_description);
  line("Numero de serie: "+c.product_serial);
  line("Estado e defeitos informados: "+c.product_condition);
  line("Acessorios inclusos: "+c.accessories);space();
  line("PAGAMENTO",12,true);
  line("Valor total: R$ 1.850,00; 10 parcelas mensais de R$ 185,00 via Pix");
  line("Chave Pix do vendedor: "+c.pix_key);
  for(const [i,d] of monthDates(c.first_due_date).entries())line("Parcela "+String(i+1).padStart(2,"0")+"  -  "+dateBR(d)+"  -  R$ 185,00",9);
  space();
  line("CONDICOES CONTRATUAIS",12,true);
  line("1. O vendedor vende o notebook usado acima identificado, com as condicoes e acessorios declarados neste instrumento.");
  line("2. A compradora se compromete a pagar dez parcelas mensais de R$ 185,00, nos vencimentos acima. Cada pagamento sera comprovado pelo credito efetivo do Pix ao vendedor.");
  line("3. O inadimplemento de parcela autoriza a cobranca dos valores vencidos pelos meios legais. O contrato nao autoriza retomada unilateral do notebook.");
  line("4. A entrega do notebook deve ser documentada separadamente por recibo, fotos ou mensagem de confirmacao. Este instrumento, isoladamente, nao comprova a entrega.");
  line("5. As partes reconhecem os dados e as condicoes do negocio, aceitam o uso de assinatura eletronica simples e autorizam o tratamento dos dados estritamente para formalizacao, prova e cobranca do contrato.");
  line("6. Eventuais divergencias devem ser resolvidas preferencialmente por acordo, respeitando a legislacao brasileira aplicavel.");
  space(12);
  line("ASSINATURAS E REGISTRO ELETRONICO",12,true);
  const drawSig=async(path:string,label:string)=>{
    if(y<185){page=pdf.addPage([595.28,841.89]);y=800;}
    const {data,error}=await admin.storage.from(bucket).download(path);
    if(error||!data)throw new Error("Assinatura privada indisponivel");
    const img=await pdf.embedPng(new Uint8Array(await data.arrayBuffer()));
    const scale=Math.min(210/img.width,64/img.height);
    page.drawImage(img,{x:47,y:y-67,width:img.width*scale,height:img.height*scale});
    y-=75;line(label,9);space(6);
  };
  await drawSig(c.seller_signature_path,"VENDEDOR: "+c.seller_name);
  await drawSig(c.buyer_signature_path,"COMPRADORA: "+c.buyer_name);
  line("Assinado em: "+new Date(c.signed_at).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"}),9);
  line("IP registrado: "+(c.signed_ip||"indisponivel"),9);
  line("Identificador do contrato: "+c.id,8);
  line("Confirmacao de concordancia: "+c.consent_version,8);
  const pages=pdf.getPages();
  pages.forEach((p,i)=>p.drawText("Smart Billing - Contrato "+c.id.slice(0,8)+" | pagina "+(i+1)+"/"+pages.length,
    {x:47,y:36,font:regular,size:8,color:rgb(.45,.48,.55)}));
  return await pdf.save();
}
async function authUser(req:Request) {
  const authorization=req.headers.get("authorization")||"";
  if(!authorization.startsWith("Bearer "))return null;
  const userClient=createClient(url,anonKey,{global:{headers:{Authorization:authorization}}});
  const {data,error}=await userClient.auth.getUser();
  if(error||!data.user)return null;
  const {data:membership}=await admin.from("company_members").select("company_id,role").eq("user_id",data.user.id).in("role",["owner","admin"]).limit(1).maybeSingle();
  return membership?{user:data.user,company_id:membership.company_id}:null;
}
async function byToken(token:string){
  if(!/^[A-Za-z0-9_-]{40,60}$/.test(token))return null;
  const token_hash=await hex(token);
  const {data}=await admin.from("sale_contracts").select("*").eq("token_hash",token_hash).maybeSingle();
  return data;
}
async function privateLink(c:any){
  const {data,error}=await admin.storage.from(bucket).createSignedUrl(c.pdf_path,600);
  if(error||!data?.signedUrl)throw new Error("PDF indisponivel");
  return data.signedUrl;
}
function pdfBase64(bytes:Uint8Array):string {
  let result="";for(let i=0;i<bytes.length;i+=8192)result+=String.fromCharCode(...bytes.slice(i,i+8192));
  return btoa(result);
}
async function sendPDF(to:string,name:string,bytes:Uint8Array,id:string):Promise<string>{
  const api=Deno.env.get("RESEND_API_KEY")||"",from=Deno.env.get("EMAIL_FROM")||"";
  if(!api||!from)return "nao_configurado";
  const response=await fetch("https://api.resend.com/emails",{
    method:"POST",headers:{"Authorization":"Bearer "+api,"Content-Type":"application/json"},
    body:JSON.stringify({from,to:[to],subject:"Contrato de venda do notebook - copia assinada",
      html:"<p>Ola "+name.replace(/[<>&"]/g,"")+"!</p><p>Segue em anexo a copia do contrato de compra e venda do notebook ASUS, assinada eletronicamente.</p><p>Guarde este arquivo junto aos comprovantes dos pagamentos mensais.</p>",
      attachments:[{filename:"contrato-notebook-"+id.slice(0,8)+".pdf",content:pdfBase64(bytes)}]})
  });
  return response.ok?"enviado":"falhou";
}
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{headers:CORS,status:204});
  if(req.method!=="POST")return reply({error:"Metodo nao permitido"},405);
  try{
    const body=await req.json();
    const action=plain(body.action,20);
    if(action==="create"){
      const actor=await authUser(req);if(!actor)return reply({error:"Acesso nao autorizado"},401);
      const vals={
        seller_name:plain(body.seller_name,120),seller_cpf:digits(plain(body.seller_cpf)),
        seller_address:plain(body.seller_address,250),seller_email:plain(actor.user.email,180),
        product_description:plain(body.product_description,180),product_serial:plain(body.product_serial,100),
        product_condition:plain(body.product_condition,300),accessories:plain(body.accessories,200)||"Nao informado",
        pix_key:plain(body.pix_key,120),first_due_date:plain(body.first_due_date,10)
      };
      const sig=plain(body.signature_png,350000);
      if(!cpfOK(vals.seller_cpf)||!emailOK(vals.seller_email)||!vals.seller_name||!vals.seller_address||
        !vals.product_description||!vals.product_serial||!vals.product_condition||!vals.pix_key||
        !/^\d{4}-\d{2}-\d{2}$/.test(vals.first_due_date)||!Number.isFinite(Date.parse(vals.first_due_date))||!sigOK(sig))
        return reply({error:"Preencha todos os campos e assine como vendedor"},422);
      const raw=crypto.getRandomValues(new Uint8Array(32));
      const token=btoa(String.fromCharCode(...raw)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
      const id=crypto.randomUUID();
      const signaturePath=id+"/vendedor.png";
      const {error:uploadErr}=await admin.storage.from(bucket).upload(signaturePath,sigBytes(sig),{contentType:"image/png",upsert:false});
      if(uploadErr)throw uploadErr;
      const {error}=await admin.from("sale_contracts").insert({
        id,company_id:actor.company_id,created_by:actor.user.id,token_hash:await hex(token),
        seller_signature_path:signaturePath,...vals
      });
      if(error)throw error;
      return reply({success:true,id,status:"pending",url:site+"/assinar-contrato.html?token="+token});
    }
    if(action==="list"){
      const actor=await authUser(req);if(!actor)return reply({error:"Acesso nao autorizado"},401);
      const {data,error}=await admin.from("sale_contracts")
        .select("id,status,created_at,signed_at,product_description,first_due_date,buyer_name,email_buyer_status,email_seller_status")
        .eq("company_id",actor.company_id).order("created_at",{ascending:false}).limit(100);
      if(error)throw error;return reply({success:true,contracts:data});
    }
    if(action==="refresh"){
      const actor=await authUser(req);if(!actor)return reply({error:"Acesso nao autorizado"},401);
      const id=plain(body.id,40);
      const {data:c}=await admin.from("sale_contracts").select("id,status").eq("id",id)
        .eq("company_id",actor.company_id).maybeSingle();
      if(!c||c.status!=="pending")return reply({error:"Somente contratos pendentes permitem novo link"},409);
      const raw=crypto.getRandomValues(new Uint8Array(32));
      const token=btoa(String.fromCharCode(...raw)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
      const {error}=await admin.from("sale_contracts").update({token_hash:await hex(token)})
        .eq("id",id).eq("status","pending");
      if(error)throw error;
      return reply({success:true,url:site+"/assinar-contrato.html?token="+token});
    }
    if(action==="get"){
      const c=await byToken(plain(body.token,128));if(!c)return reply({error:"Link invalido ou expirado"},404);
      return reply({success:true,contract:{
        status:c.status,seller_name:c.seller_name,seller_address:c.seller_address,
        product_description:c.product_description,product_serial:c.product_serial,
        product_condition:c.product_condition,accessories:c.accessories,pix_key:c.pix_key,
        first_due_date:c.first_due_date,installments:monthDates(c.first_due_date),
        buyer_name:c.status==="signed"?c.buyer_name:null
      }});
    }
    if(action==="download"){
      let c=null;
      if(body.id){
        const actor=await authUser(req);if(!actor)return reply({error:"Acesso nao autorizado"},401);
        const {data}=await admin.from("sale_contracts").select("*").eq("id",plain(body.id,40))
          .eq("company_id",actor.company_id).maybeSingle();c=data;
      }else c=await byToken(plain(body.token,128));
      if(!c||c.status!=="signed"||!c.pdf_path)return reply({error:"Contrato nao assinado"},404);
      return reply({success:true,url:await privateLink(c),sha256:c.pdf_sha256});
    }
    if(action==="sign"){
      const c=await byToken(plain(body.token,128));if(!c||c.status!=="pending")return reply({error:"Contrato indisponivel para assinatura"},409);
      const buyer={
        buyer_name:plain(body.name,120),buyer_cpf:digits(plain(body.cpf)),buyer_email:plain(body.email,180),
        buyer_phone:plain(body.phone,40),buyer_address:plain(body.address,250)
      };
      const sig=plain(body.signature_png,350000);
      if(!cpfOK(buyer.buyer_cpf)||!emailOK(buyer.buyer_email)||!buyer.buyer_name||!buyer.buyer_address||
         !sigOK(sig)||body.accepted!==true)return reply({error:"Dados, aceite ou assinatura invalidos"},422);
      const signed_at=new Date().toISOString();
      const ip=(req.headers.get("cf-connecting-ip")||req.headers.get("x-forwarded-for")||"").split(",")[0].slice(0,64);
      const ua=plain(req.headers.get("user-agent"),500);
      const {data:locked,error:lockError}=await admin.from("sale_contracts")
        .update({status:"signing"}).eq("id",c.id).eq("status","pending").select("id").maybeSingle();
      if(lockError||!locked)return reply({error:"Contrato ja esta sendo assinado"},409);
      try{
        const path=c.id+"/compradora.png";
        const {error:pngErr}=await admin.storage.from(bucket).upload(path,sigBytes(sig),{contentType:"image/png",upsert:true});
        if(pngErr)throw pngErr;
        const record={...c,...buyer,buyer_signature_path:path,signed_at,signed_ip:ip,signed_user_agent:ua,consent_version:"v1-2026-11-06"};
        const bytes=await createPDF(record);
        const pdfPath=c.id+"/contrato-assinado.pdf";
        const {error:pdfErr}=await admin.storage.from(bucket).upload(pdfPath,bytes,{contentType:"application/pdf",upsert:false});
        if(pdfErr)throw pdfErr;
        const pdf_sha256=await hex(bytes);
        const {error:finishErr}=await admin.from("sale_contracts").update({
          ...buyer,buyer_signature_path:path,signed_at,signed_ip:ip,signed_user_agent:ua,
          consent_version:"v1-2026-11-06",pdf_path:pdfPath,pdf_sha256,status:"signed"
        }).eq("id",c.id).eq("status","signing");
        if(finishErr)throw finishErr;
        const [recipient,seller]=await Promise.allSettled([
          sendPDF(buyer.buyer_email,buyer.buyer_name,bytes,c.id),
          sendPDF(c.seller_email,c.seller_name,bytes,c.id)
        ]);
        const buyerStatus=recipient.status==="fulfilled"?recipient.value:"falhou";
        const sellerStatus=seller.status==="fulfilled"?seller.value:"falhou";
        await admin.from("sale_contracts").update({email_buyer_status:buyerStatus,email_seller_status:sellerStatus}).eq("id",c.id);
        return reply({success:true,status:"signed",url:await privateLink({pdf_path:pdfPath}),
          email_buyer_status:buyerStatus,email_seller_status:sellerStatus});
      }catch(e){
        await admin.from("sale_contracts").update({status:"pending"}).eq("id",c.id).eq("status","signing");
        throw e;
      }
    }
    return reply({error:"Acao nao reconhecida"},400);
  }catch(e){
    console.error("contracts-service: ",String(e).slice(0,300));
    return reply({error:"Nao foi possivel concluir esta operacao"},500);
  }
});
