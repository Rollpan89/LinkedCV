(() => {
  if (globalThis.__cvAdapterContentInstalled) return;
  globalThis.__cvAdapterContentInstalled = true;

  const normalize = value => String(value || '').replace(/\u00a0/g, ' ').replace(/[\t ]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const visibleText = node => normalize(node?.innerText || node?.textContent || '');
  const NOISE = /^(?:sign in|log in|join now|gå med nu|logga in|apply|ansök|save|spara|share|dela|report|rapportera|see more|show more|visa mer)$/i;
  const DESC_HEADING = /about the job|job description|the role|responsibilities|requirements|qualifications|what you.ll do|om jobbet|arbetsbeskrivning|ansvarsområden|kvalifikationer|kravprofil|vi söker|din profil|dina arbetsuppgifter/i;
  const SKILL_WORDS = /experience|erfarenhet|knowledge|kunskap|proficiency|kompetens|skills|färdigheter|requirements|krav|responsibilit|arbetsuppgift|qualifications|kvalifikation|merit|utbildning|years|år\b/i;
  const NOISE_WORDS = /recommended jobs|similar jobs|people also viewed|jobs you may like|liknande jobb|andra jobb|personer har även tittat|cookie|privacy|sekretess|navigation|main menu/i;

  function parseStructuredJobs() {
    const found = [];
    const visit = value => {
      if (!value) return;
      if (Array.isArray(value)) return value.forEach(visit);
      if (typeof value !== 'object') return;
      const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
      if (types.some(t => String(t).toLowerCase() === 'jobposting')) found.push(value);
      Object.values(value).forEach(v => { if (v && typeof v === 'object') visit(v); });
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
      try { visit(JSON.parse(script.textContent || 'null')); } catch (_) {}
    });
    return found.sort((a,b) => htmlText(b.description).length - htmlText(a.description).length)[0] || null;
  }
  function htmlText(html) {
    const t = document.createElement('template'); t.innerHTML = String(html || '');
    t.content.querySelectorAll('script,style,noscript,svg').forEach(n => n.remove());
    return normalize(t.content.textContent || '');
  }
  function isVisible(el) {
    if (!(el instanceof Element) || el.closest('[aria-hidden="true"], [hidden]')) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function usable(el) {
    if (!isVisible(el)) return false;
    if (el.matches('script,style,noscript,svg,nav,footer,form,button,input,textarea,select,[role="navigation"],[role="menu"],[role="toolbar"]')) return false;
    if (el.closest('nav,footer,[role="navigation"],[role="menu"]')) return false;
    return true;
  }
  function unique(nodes) { return [...new Set(nodes)].filter(Boolean); }

  function waitForStableDom(timeout = 4500, quiet = 500) {
    return new Promise(resolve => {
      let quietTimer, hardTimer, done = false;
      const finish = () => { if (done) return; done = true; observer.disconnect(); clearTimeout(quietTimer); clearTimeout(hardTimer); resolve(); };
      const reset = () => { clearTimeout(quietTimer); quietTimer = setTimeout(finish, quiet); };
      const observer = new MutationObserver(reset);
      observer.observe(document.documentElement, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['aria-expanded','hidden']});
      hardTimer = setTimeout(finish, timeout); reset();
    });
  }
  function expandRelevantSections(scope) {
    if (!scope) return 0;
    const controls = [...scope.querySelectorAll('button,[role="button"]')].filter(isVisible);
    let expanded = 0;
    controls.forEach(button => {
      const label = normalize(`${visibleText(button)} ${button.getAttribute('aria-label') || ''}`).toLowerCase();
      if (/(?:show more|see more|visa mer|visa fler|read more|läs mer|…\s*mer|\.\.\.+\s*mer|\.\.\.+\s*more)/i.test(label) && !/show less|see less|visa mindre|läs mindre/i.test(label)) {
        try { button.click(); expanded++; } catch (_) {}
      }
    });
    return expanded;
  }
  function postingLocation(posting) {
    const loc = posting?.jobLocation;
    const first = Array.isArray(loc) ? loc[0] : loc;
    const a = first?.address;
    return a ? [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(', ') : '';
  }
  function orgName(posting) {
    const org = posting?.hiringOrganization;
    return normalize(typeof org === 'string' ? org : org?.name || '');
  }
  function metaContent(selector) { return normalize(document.querySelector(selector)?.content || ''); }

  function semanticRoots() {
    return unique([
      ...document.querySelectorAll('main, article, section, [role="main"], [role="dialog"], dialog, [itemtype*="JobPosting"]'),
      document.body
    ]).filter(usable).filter(el => visibleText(el).length > 120);
  }
  function headingCandidates() {
    return [...document.querySelectorAll('h1,[role="heading"][aria-level="1"],h2,h3,[role="heading"]')]
      .filter(usable).map(el => ({el, text:visibleText(el), level:Number(el.getAttribute('aria-level') || el.tagName.slice(1)) || 6}))
      .filter(x => x.text && x.text.length < 150 && !NOISE.test(x.text));
  }
  const NON_JOB_HEADINGS = /^(?:people you can contact|personer du kan kontakta|people also viewed|personer har även tittat på|similar jobs|liknande jobb|recommended jobs|rekommenderade jobb|about the job|om jobbet|job details|jobbdetaljer|company|företag|benefits|förmåner|activity|aktivitet|how you match|så matchar du|meet the hiring team|träffa rekryteringsteamet)$/i;
  const JOB_TITLE_WORDS = /senior|junior|systemutvecklare|utvecklare|developer|engineer|ingenjör|arkitekt|manager|chef|designer|specialist|analyst|analytiker|tekniker|konsult|product owner|projektledare|frontend|backend|fullstack|devops|data scientist/i;
  function titleMetaCandidates() {
    const raw = [
      metaContent('meta[property="og:title"]'),
      metaContent('meta[name="twitter:title"]'),
      normalize(document.title)
    ].filter(Boolean);
    return raw.map(value => normalize(value
      .replace(/\s*[|–—-]\s*(?:LinkedIn.*|Jobb på LinkedIn.*)$/i, '')
      .replace(/\s*[|–—]\s*[^|–—]{2,80}\s*[|–—]\s*LinkedIn.*$/i, '')
    )).filter(value => value && !/linkedin|sign in|log in|logga in/i.test(value));
  }
  function scoreTitle(candidate, root, index, allHeadings) {
    const text = candidate.text;
    if (NON_JOB_HEADINGS.test(text)) return -100;
    let score = candidate.level === 1 ? 15 : candidate.level === 2 ? 7 : candidate.level === 3 ? 2 : 0;
    if (text.length >= 6 && text.length <= 90) score += 5;
    if (JOB_TITLE_WORDS.test(text)) score += 9;
    if (/\b(people|personer|contact|kontakta|viewed|tittat|jobs|jobb|activity|aktivitet)\b/i.test(text)) score -= 18;
    if (/linkedin|jobs|jobb|sign in|log in/i.test(text)) score -= 20;
    if (root && root.contains(candidate.el)) score += 2;
    // Job identity normally appears before the description and before secondary page sections.
    score += Math.max(0, 8 - index * 0.45);
    // A company link immediately before/above a heading is a strong job-header signal.
    const parent = candidate.el.parentElement;
    const previous = candidate.el.previousElementSibling;
    const nearby = normalize([previous && visibleText(previous), parent && visibleText(parent)].filter(Boolean).join(' '));
    if (nearby.length < 260 && nearby.length > text.length && /Länsförsäkringar|company|företag|·|\|/i.test(nearby)) score += 5;
    if (allHeadings.slice(0, Math.max(index, 1)).some(h => DESC_HEADING.test(h.text))) score -= 7;
    return score;
  }
  function parseMetaJobTitle(value) {
    if (!value) return '';
    // LinkedIn commonly formats titles as "Role | Company | LinkedIn" or "Role | Company".
    const cleaned = value.replace(/\s*[|–—]\s*LinkedIn.*$/i, '').trim();
    const parts = cleaned.split(/\s*[|–—]\s*/).map(normalize).filter(Boolean);
    return parts.length >= 2 ? parts[0] : cleaned;
  }
  function getCurrentJobId() {
    const url = new URL(location.href);
    const pathId = url.pathname.match(/\/jobs\/view\/(\d+)/)?.[1] || '';
    return pathId || url.searchParams.get('currentJobId') || '';
  }
  function activeJobScopes(roots = []) {
    const id = getCurrentJobId();
    const exact = id ? [...document.querySelectorAll(`[data-job-id="${id}"]`)].filter(usable) : [];
    const known = [...document.querySelectorAll('.jobs-search__job-details--container,.jobs-search__job-details,.job-details-jobs-unified-top-card,.jobs-unified-top-card')].filter(usable);
    const main = [...document.querySelectorAll('main,[role="main"]')].filter(usable);
    return unique([...exact, ...known, ...main, ...roots]).filter(el => visibleText(el).length > 100)
      .sort((a,b) => visibleText(a).length - visibleText(b).length);
  }
  function findJobTitleByJobId() {
    const id = getCurrentJobId();
    if (!id) return null;
    const links = [...document.querySelectorAll('a[href*="/jobs/view/"]')].filter(usable).map(el => {
      let hrefId = '';
      try { hrefId = new URL(el.href, location.origin).pathname.match(/\/jobs\/view\/(\d+)/)?.[1] || ''; } catch (_) {}
      return { el, hrefId, text: visibleText(el) };
    }).filter(x => x.hrefId === id && x.text.length >= 4 && x.text.length <= 120 && !NON_JOB_HEADINGS.test(x.text));
    const uniqueTexts = [...new Set(links.map(x => x.text))];
    if (uniqueTexts.length === 1) return { value: uniqueTexts[0], source: `annonslänk med exakt jobb-ID ${id}`, element: links.find(x => x.text === uniqueTexts[0]).el, jobId: id };
    if (uniqueTexts.length > 1) return { value:'', source:'flera möjliga titlar för samma jobb-ID', ambiguous:true, jobId:id };
    return null;
  }
  function findTitleInActiveHeader(roots = []) {
    const selectors = '[data-test-job-title],[data-job-title],.job-details-jobs-unified-top-card__job-title,.job-details-jobs-unified-top-card__job-title-link,.jobs-unified-top-card__job-title,.jobs-details-top-card__job-title';
    const candidates = [];
    activeJobScopes(roots).forEach(scope => {
      if (scope.matches?.(selectors)) candidates.push(scope);
      candidates.push(...scope.querySelectorAll(selectors));
    });
    const normalized = unique(candidates).filter(usable).map(el => ({el,text:visibleText(el)}))
      .filter(x => x.text.length >= 4 && x.text.length <= 120 && !NON_JOB_HEADINGS.test(x.text));
    const uniqueTexts = [...new Set(normalized.map(x => x.text))];
    if (uniqueTexts.length === 1) return {value:uniqueTexts[0], source:'LinkedIn-jobbhuvudets titel-element', element:normalized.find(x=>x.text===uniqueTexts[0]).el, jobId:getCurrentJobId()};

    // LinkedIn may render the title as a bare text node (not a heading or
    // element). Resolve it relative to the active employer link, rather than
    // ranking every title-like element on the whole job page.
    const scopes = activeJobScopes(roots);
    const depthOf = el => { let depth=0; for (let node=el; node; node=node.parentElement) depth++; return depth; };
    for (const scope of scopes) {
      const companyLinks = [...scope.querySelectorAll('a[href*="/company/"]')].filter(usable);
      for (const companyLink of companyLinks) {
        let compact = companyLink.parentElement;
        for (let depth=0; compact && depth<6; depth++, compact=compact.parentElement) {
          const compactText = visibleText(compact);
          if (compactText.length > 1200) continue;
          const nearby = [...compact.querySelectorAll('*')].filter(usable).map(el => ({el,text:visibleText(el)}))
            .filter(x => x.el !== companyLink && x.text.length >= 5 && x.text.length <= 100 && JOB_TITLE_WORDS.test(x.text) && !NON_JOB_HEADINGS.test(x.text))
            .filter(x => { try { return Boolean(companyLink.compareDocumentPosition(x.el) & Node.DOCUMENT_POSITION_FOLLOWING); } catch (_) { return false; } });
          const textNodes = [];
          const walker = document.createTreeWalker(compact, NodeFilter.SHOW_TEXT);
          let textNode;
          while ((textNode = walker.nextNode())) {
            const value = normalize(textNode.nodeValue || '');
            const parent = textNode.parentElement;
            if (!parent || parent.closest('a,button,[aria-hidden="true"]') || value.length < 5 || value.length > 100) continue;
            if (!JOB_TITLE_WORDS.test(value) || NON_JOB_HEADINGS.test(value)) continue;
            try {
              if (companyLink.compareDocumentPosition(textNode) & Node.DOCUMENT_POSITION_FOLLOWING) {
                textNodes.push({el:parent,text:value,node:textNode});
              }
            } catch (_) {}
          }
          // A bare text node is stronger evidence than broad descendant text,
          // which can include nested metadata and duplicate labels.
          const textNodeValues = [...new Set(textNodes.map(x=>x.text))];
          if (textNodeValues.length === 1) {
            const match = textNodes.find(x=>x.text===textNodeValues[0]);
            return {value:match.text, source:'titeltextnod i aktivt jobbhuvud efter företagslänken', element:match.el, jobId:getCurrentJobId()};
          }
          const texts = [...new Set(nearby.map(x=>x.text))];
          if (texts.length === 1) {
            const match = nearby.filter(x=>x.text===texts[0]).sort((a,b)=>depthOf(b.el)-depthOf(a.el))[0];
            return {value:match.text, source:'titeltext i aktivt jobbhuvud efter företagslänken', element:match.el, jobId:getCurrentJobId()};
          }
        }
      }
    }
    if (uniqueTexts.length > 1) return {value:'', source:'flera titlar i aktivt jobbhuvud', ambiguous:true, jobId:getCurrentJobId()};
    return null;
  }
  function findJobTitle(posting, roots) {
    const exactLink = findJobTitleByJobId();
    if (exactLink?.value || exactLink?.ambiguous) return exactLink;
    if (posting?.title) return {value:normalize(posting.title), source:'JSON-LD'};
    const headerTitle = findTitleInActiveHeader(roots);
    if (headerTitle?.value || headerTitle?.ambiguous) return headerTitle;
    const metaTitles = titleMetaCandidates();
    for (const raw of metaTitles) {
      const candidate = parseMetaJobTitle(raw);
      if (candidate && candidate.length >= 5 && candidate.length <= 100 && !NON_JOB_HEADINGS.test(candidate)) {
        if (JOB_TITLE_WORDS.test(candidate) || candidate.split(' ').length <= 8) return {value:candidate, source:'Open Graph / dokumenttitel'};
      }
    }
    const scopes = activeJobScopes(roots);
    const headings = headingCandidates().filter(h => scopes.some(scope => scope === h.el || scope.contains(h.el)));
    const root = scopes[0] || roots.slice().sort((a,b) => visibleText(a).length-visibleText(b).length)[0];
    const ranked = headings.map((h,i) => ({...h, score:scoreTitle(h,root,i,headings)})).sort((a,b)=>b.score-a.score);
    const best = ranked[0];
    if (best && best.score >= 12) return {value:best.text, source:'semantisk rubrik i aktiv annons', element:best.el};
    return {value:'', source:'saknas eller osäker'};
  }
  function candidateDescriptionNodes(roots) {
    const nodes = [];
    roots.forEach(root => {
      nodes.push(root);
      nodes.push(...root.querySelectorAll('section,article,div,[role="region"],[itemprop="description"],p,ul,ol'));
    });
    return unique(nodes).filter(usable);
  }
  function headingContext(el) {
    const parts = [];
    let n = el;
    for (let i=0; n && i<4; i++, n=n.parentElement) {
      const hs = [...n.querySelectorAll('h2,h3,h4,[role="heading"]')].slice(0,8).map(visibleText).filter(Boolean);
      parts.push(...hs);
    }
    return parts.join(' ');
  }
  function findJobDescriptionSection(roots = []) {
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,[role="heading"]')]
      .filter(usable).filter(el => /^(?:om jobbet|about the job|job description|arbetsbeskrivning)$/i.test(visibleText(el)));
    const scopes = activeJobScopes(roots);
    for (const heading of headings) {
      if (scopes.length && !scopes.some(scope => scope === heading || scope.contains(heading))) continue;
      let node = heading;
      for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
        const value = visibleText(node);
        if (value.length >= 180 && value.length <= 22000) return node;
      }
    }
    return null;
  }
  function scoreDescription(el, roots) {
    const value = visibleText(el);
    if (value.length < 180) return -Infinity;
    const lower = value.toLowerCase();
    let score = Math.min(value.length / 450, 18);
    const headings = headingContext(el);
    if (DESC_HEADING.test(headings)) score += 14;
    if (SKILL_WORDS.test(value)) score += 5;
    const listItems = el.querySelectorAll('li').length;
    score += Math.min(listItems, 18) * 0.55;
    const paragraphs = el.querySelectorAll('p').length;
    score += Math.min(paragraphs, 12) * 0.35;
    if (el.matches('article,section,[itemprop="description"]')) score += 3;
    if (roots.some(r => r === el || r.contains(el))) score += 2;
    if (NOISE_WORDS.test(lower)) score -= 12;
    const controls = el.querySelectorAll('button,a').length;
    score -= Math.min(controls / Math.max(value.length/120,1), 8);
    // Penalize giant page wrappers that aggregate unrelated cards and navigation.
    if (value.length > 18000 && listItems > 35) score -= 8;
    return score;
  }
  function extractDescription(posting, roots, scopedSection = null) {
    const candidates = candidateDescriptionNodes(roots).map(el => ({el,value:visibleText(el),score:scoreDescription(el,roots)}))
      .filter(x => Number.isFinite(x.score)).sort((a,b)=>b.score-a.score);
    if (scopedSection) {
      const raw = visibleText(scopedSection);
      const lines = raw.split(/\n+/);
      const headingIndex = lines.findIndex(line => /^(?:om jobbet|about the job|job description|arbetsbeskrivning)$/i.test(normalize(line)));
      const scopedText = normalize((headingIndex >= 0 ? lines.slice(headingIndex + 1) : lines).join('\n')
        .replace(/(?:…|\.{2,})\s*(?:mer|more)\s*$/i, ''));
      if (scopedText.length >= 180) return {value:scopedText, source:'LinkedIn-sektionen "Om jobbet"', score:30, candidates:candidates.length, scoped:true};
    }
    const best = candidates[0];
    const structured = htmlText(posting?.description || '');
    if (structured.length >= 180 && (!best || structured.length >= best.value.length * 0.78)) return {value:structured, source:'JSON-LD JobPosting.description', score:20, candidates:candidates.length, scoped:false};
    if (best) return {value:best.value, source:'semantisk DOM-rangordning', score:Math.round(best.score*10)/10, candidates:candidates.length, scoped:false};
    return {value:structured, source:structured?'JSON-LD JobPosting.description':'saknas', score:structured.length>=180?20:0, candidates:candidates.length, scoped:false};
  }
  function nearbyMetadata(title, posting, titleElement = null) {
    const result = {company:orgName(posting), location:postingLocation(posting), employmentType:normalize((Array.isArray(posting?.employmentType)?posting.employmentType:[posting?.employmentType]).filter(Boolean).join(', '))};
    const titleNode = titleElement || headingCandidates().find(h => h.text === title)?.el;
    if (titleNode) {
      // Inspect the compact job-header neighborhood, especially preceding siblings:
      // LinkedIn places the employer immediately above the role title in this layout.
      let scope = titleNode.parentElement;
      for (let depth=0; scope && depth<5; depth++, scope=scope.parentElement) {
        const preceding = [];
        let sibling = titleNode;
        for (let n=0; sibling && n<4; n++, sibling=sibling.previousElementSibling) {
          if (sibling !== titleNode) preceding.unshift(sibling);
        }
        const beforeText = normalize(preceding.map(visibleText).join(' '));
        const links = [...scope.querySelectorAll('a')].filter(usable)
          .map(a=>({text:visibleText(a),el:a})).filter(x=>x.text && x.text.length<100 && !NOISE.test(x.text));
        if (!result.company) {
          const beforeLinks = links.filter(x => {
            try { return Boolean(x.el.compareDocumentPosition(titleNode) & Node.DOCUMENT_POSITION_FOLLOWING); }
            catch (_) { return false; }
          });
          const plausible = beforeLinks.map(x=>x.text).find(t=>t.length>=2 && t.length<=80 && !NON_JOB_HEADINGS.test(t));
          if (plausible) result.company = plausible;
          if (!result.company && beforeText && beforeText.length<=120) {
            const lines = beforeText.split(/\n|\s[·|•]\s/).map(normalize).filter(Boolean);
            const companyLine = lines.reverse().find(t=>t.length>=2 && t.length<=80 && !NON_JOB_HEADINGS.test(t) && !JOB_TITLE_WORDS.test(t));
            if (companyLine) result.company = companyLine;
          }
        }
        const text = visibleText(scope);
        if (!result.location && text.length < 1200) {
          const lines = text.split(/\n|\s[·|•]\s/).map(normalize).filter(Boolean);
          const loc = lines.find(line => /,|\b(remote|hybrid|på plats|distans|stockholm|göteborg|malmö|sweden|sverige)\b/i.test(line) && line.length < 100 && line !== title);
          if (loc) result.location = loc;
        }
        if (result.company && result.location) break;
      }
    }
    if (!result.company) {
      const titleMeta = metaContent('meta[property="og:title"]') || metaContent('meta[name="twitter:title"]') || normalize(document.title);
      const cleaned = titleMeta.replace(/\s*[|–—]\s*LinkedIn.*$/i, '');
      const parts = cleaned.split(/\s*[|–—]\s*/).map(normalize).filter(Boolean);
      if (parts.length >= 2 && parts[1].length <= 100 && !NON_JOB_HEADINGS.test(parts[1])) result.company = parts[1];
    }
    if (!result.company) {
      const orgMeta = metaContent('meta[property="og:site_name"]');
      if (orgMeta && !/linkedin/i.test(orgMeta)) result.company = orgMeta;
    }
    return result;
  }
  function summarizeRoots(roots) {
    return roots.slice(0,8).map(r=>({tag:r.tagName.toLowerCase(),role:r.getAttribute('role')||'',textLength:visibleText(r).length}));
  }

  async function extractJob() {
    await waitForStableDom(3200,450);
    let roots = semanticRoots();
    let descriptionScope = findJobDescriptionSection(roots);
    if (descriptionScope && expandRelevantSections(descriptionScope) > 0) {
      await waitForStableDom(2200,450);
      roots = semanticRoots();
      descriptionScope = findJobDescriptionSection(roots);
    }
    const posting = parseStructuredJobs();
    const titleInfo = findJobTitle(posting, roots);
    const meta = nearbyMetadata(titleInfo.value, posting, titleInfo.element || null);
    const desc = extractDescription(posting, roots, descriptionScope);
    const description = normalize(desc.value);
    const metadata = [titleInfo.value && `Tjänst: ${titleInfo.value}`, meta.company && `Företag: ${meta.company}`, meta.location && `Plats: ${meta.location}`, meta.employmentType && `Anställningstyp: ${meta.employmentType}`].filter(Boolean).join('\n');
    const text = normalize([metadata,description].filter(Boolean).join('\n\n'));
    const confidence = Math.max(0,Math.min(100,Math.round((titleInfo.value?20:0)+(description.length>=1000?40:description.length>=400?30:description.length>=80?18:0)+(desc.score>=15?15:desc.score>=8?8:0)+(meta.company?10:0)+(posting?10:0)+(meta.location?5:0))));
    const extractionWarnings = [];
    if (!titleInfo.value) extractionWarnings.push('Tjänstens titel kunde inte identifieras automatiskt.');
    if (!meta.company) extractionWarnings.push('Arbetsgivaren kunde inte identifieras automatiskt.');
    if (!meta.location) extractionWarnings.push('Plats kunde inte identifieras automatiskt.');
    if (!descriptionScope) extractionWarnings.push('Sektionen "Om jobbet" hittades inte; annonstexten hämtades från en alternativ källa.');
    if (description.length < 500) extractionWarnings.push('Annonstexten är ovanligt kort. Kontrollera att hela beskrivningen har expanderats.');
    if (desc.mayBeIncomplete) extractionWarnings.push('LinkedIn visar fortfarande en Visa mer-kontroll. Beskrivningen kan vara ofullständig.');
    return {
      title:titleInfo.value, company:meta.company, location:meta.location, employmentType:meta.employmentType,
      description, text,
      diagnostics:{engine:'semantic-content-v6', jobId:getCurrentJobId(), titleSource:titleInfo.source, titleAmbiguous:Boolean(titleInfo.ambiguous), descriptionSource:desc.source, descriptionLength:description.length,
        descriptionScore:desc.score, descriptionScoped:Boolean(desc.scoped), descriptionScopeFound:Boolean(descriptionScope), descriptionMayBeIncomplete:Boolean(desc.mayBeIncomplete), extractionWarnings,
        candidateCount:desc.candidates, titleFound:Boolean(titleInfo.value), companyFound:Boolean(meta.company), locationFound:Boolean(meta.location),
        jsonLdFound:Boolean(posting), confidence, roots:summarizeRoots(roots), capturedAt:new Date().toISOString()}
    };
  }


  chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
    if (message?.type === 'EXTRACT_JOB_AD') {
      extractJob().then(sendResponse).catch(error=>sendResponse({error:error?.message||String(error)}));
      return true;
    }
    if (message?.type === 'PING_CV_ADAPTER') { sendResponse({ok:true}); return false; }
  });
})();
