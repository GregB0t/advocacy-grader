// Catalogue of employee-advocacy and employee-communications platforms.
//
// tier matters for how a match is interpreted downstream:
//   'advocacy' — a direct EveryoneSocial competitor. Its whole job is getting
//                employees to share company content externally.
//   'comms'    — an internal comms / intranet / frontline platform. Many of
//                these bundle an advocacy or "social sharing" module, but a
//                match does NOT prove the customer bought or uses that module.
//                Downstream must not treat these as equivalent.
//   'social'   — a social media management suite with an advocacy add-on.
//
// altDomains are OTHER domains the vendor owns and stamps on customer apps as
// the seller URL -- Haiilo uses coyoapp.com, not haiilo.com. Missing these
// collapses every customer of that vendor onto one bogus 'customer' domain.
//
// playDeveloper is the Google Play developer name, which often differs from the
// Apple seller name (Staffbase is 'Staffbase GmbH' on Apple, 'Staffbase SE' on
// Play). Play's static developer page shows at most 20 apps, so Play coverage
// is a partial top-up, never a full list.
//
// artistId is the Apple developer account. Vendors publish their customers'
// white-labeled apps under it, which is what makes this index possible.
// Resolved and verified live 2026-08-28 via the iTunes Search API.

export const VENDORS = [
  // --- direct advocacy competitors -------------------------------------
  { key: 'sociabble',      name: 'Sociabble',        tier: 'advocacy', domain: 'sociabble.com',       artistIds: [1412624719], search: ['sociabble'],            bundlePrefixes: ['com.sociabble.'], altDomains: ['brainsonic.com'], site: 'https://www.sociabble.com', fcSlug: 'sociabble' },
  { key: 'dsmn8',          name: 'DSMN8',            tier: 'advocacy', domain: 'dsmn8.com',           artistIds: [1172141474], search: ['dsmn8'],                bundlePrefixes: ['com.dsmn8.'], site: 'https://dsmn8.com', fcSlug: 'dsmn8' },
  { key: 'ambassify',      name: 'Ambassify',        tier: 'advocacy', domain: 'ambassify.com',       artistIds: [1323952584], search: ['ambassify'],            bundlePrefixes: ['com.ambassify.'], site: 'https://www.ambassify.com', fcSlug: 'ambassify' },
  { key: 'gaggleamp',      name: 'GaggleAMP',        tier: 'advocacy', domain: 'gaggleamp.com',       artistIds: [840936106],  search: ['gaggleamp'],            bundlePrefixes: ['com.gaggleamp.'], site: 'https://www.gaggleamp.com', fcSlug: 'gaggleamp' },
  { key: 'oktopost',       name: 'Oktopost',         tier: 'advocacy', domain: 'oktopost.com',        artistIds: [1095137629], search: ['oktopost'],             bundlePrefixes: ['com.oktopost.'], playDeveloper: 'Oktopost', site: 'https://www.oktopost.com', fcSlug: 'oktopost' },
  { key: 'clearview',      name: 'Clearview Social', tier: 'advocacy', domain: 'clearviewsocial.com', artistIds: [1447902400], search: ['clearview social'],     bundlePrefixes: ['com.clearviewsocial.'], site: 'https://clearviewsocial.com', fcSlug: 'clearview-social' },
  { key: 'haiilo_amplify', name: 'Haiilo Amplify (Smarp)', tier: 'advocacy', domain: 'haiilo.com',    artistIds: [919085536],  search: ['smarp', 'haiilo amplify'], bundlePrefixes: ['com.smarpsocial.'], altDomains: ['smarp.com','smarpsocial.com','coyoapp.com'], site: 'https://haiilo.com', fcSlug: 'haiilo' },
  { key: 'postbeyond',     name: 'PostBeyond',       tier: 'advocacy', domain: 'postbeyond.com',      artistIds: [],           search: ['postbeyond'],           bundlePrefixes: ['com.postbeyond.'], site: 'https://www.postbeyond.com', fcSlug: 'postbeyond' },
  { key: 'sociuu',         name: 'Sociuu',           tier: 'advocacy', domain: 'sociuu.com',          artistIds: [],           search: ['sociuu'],               bundlePrefixes: ['com.sociuu.'], site: 'https://sociuu.com', fcSlug: 'sociuu' },
  { key: 'socxo',          name: 'Socxo',            tier: 'advocacy', domain: 'socxo.com',           artistIds: [],           search: ['socxo'],                bundlePrefixes: ['com.socxo.', 'com.Socxo.'], altDomains: ['socx.ly', 'socxo.io'], site: 'https://socxo.com', fcSlug: 'socxo' },
  { key: 'apostle',        name: 'Apostle',          tier: 'advocacy', domain: 'apostle.nl',          artistIds: [],           search: ['apostle social'],       bundlePrefixes: ['com.apostle.', 'nl.apostle.'], altDomains: ['apostlesocial.com'], site: 'https://apostle.nl', fcSlug: 'apostle' },
  { key: 'denim',          name: 'Denim Social',     tier: 'advocacy', domain: 'denimsocial.com',     artistIds: [],           search: ['denim social'],         bundlePrefixes: ['com.denimsocial.'], altDomains: ['denimhead.app'], site: 'https://denimsocial.com', fcSlug: 'denim-social' },
  { key: 'seismic_social', name: 'Seismic LiveSocial', tier: 'advocacy', domain: 'seismic.com',       artistIds: [],           search: ['livesocial', 'grapevine6'], bundlePrefixes: ['com.grapevine6.', 'com.livesocial.'], site: 'https://seismic.com', fcSlug: 'seismic' },
  { key: 'socialtoaster',  name: 'SocialToaster',    tier: 'advocacy', domain: 'socialtoaster.com',   artistIds: [],           search: ['socialtoaster'],        bundlePrefixes: ['com.socialtoaster.'], site: 'https://www.socialtoaster.com', fcSlug: 'socialtoaster' },
  { key: 'everyonesocial', name: 'EveryoneSocial',   tier: 'advocacy', domain: 'everyonesocial.com',  artistIds: [805568779],  search: ['everyonesocial'],       bundlePrefixes: ['app.everyonesocial'], isClient: true, site: 'https://everyonesocial.com', fcSlug: 'everyone-social' },

  // --- employee comms / intranet platforms with advocacy modules --------
  { key: 'firstup',    name: 'Firstup (SocialChorus / Dynamic Signal)', tier: 'comms', domain: 'firstup.io', artistIds: [976326568, 553327430], search: ['firstup', 'socialchorus', 'dynamic signal'], bundlePrefixes: ['com.socialchorus.', 'com.dynamicsignal.'], altDomains: ['socialchorus.com','dynamicsignal.com','voicestorm.com'], playDeveloper: 'Firstup, Inc.', site: 'https://firstup.io', fcSlug: 'firstup' },
  { key: 'haiilo',     name: 'Haiilo (COYO)',    tier: 'comms', domain: 'haiilo.com',     artistIds: [491344947], search: ['haiilo', 'coyo'],   bundlePrefixes: ['com.coyoapp.'], altDomains: ['coyoapp.com','coyo.com','smarp.com','smarpsocial.com'], playDeveloper: 'Haiilo', site: 'https://haiilo.com', fcSlug: 'haiilo' },
  { key: 'staffbase',  name: 'Staffbase',        tier: 'comms', domain: 'staffbase.com',  artistIds: [918506037], search: ['staffbase'],        bundlePrefixes: ['com.staffbase.', 'com.mitarbeiterapp.'], altDomains: ['mitarbeiterapp.de','bananatag.com'], playDeveloper: 'Staffbase SE', site: 'https://staffbase.com', fcSlug: 'staffbase' },
  { key: 'speakap',    name: 'Speakap',          tier: 'comms', domain: 'speakap.com',    artistIds: [],          search: ['speakap'],          bundlePrefixes: ['com.speakap.'], site: 'https://www.speakap.com', fcSlug: 'speakap' },
  { key: 'beekeeper',  name: 'Beekeeper',        tier: 'comms', domain: 'beekeeper.io',   artistIds: [],          search: ['beekeeper app'],    bundlePrefixes: ['com.beekeeper.'], altDomains: ['beekeeper.ch'], playDeveloper: 'Beekeeper AG', site: 'https://www.beekeeper.io', fcSlug: 'beekeeper' },
  { key: 'workvivo',   name: 'Workvivo',         tier: 'comms', domain: 'workvivo.com',   artistIds: [],          search: ['workvivo'],         bundlePrefixes: ['com.workvivo.'], altDomains: ['workvivo.io'], site: 'https://www.workvivo.com', fcSlug: 'workvivo' },
  { key: 'simpplr',    name: 'Simpplr',          tier: 'comms', domain: 'simpplr.com',    artistIds: [],          search: ['simpplr'],          bundlePrefixes: ['com.simpplr.'], altDomains: ['simpplr.io'], playDeveloper: 'Simpplr Inc.', site: 'https://www.simpplr.com', fcSlug: 'simpplr' },
  { key: 'lumapps',    name: 'LumApps',          tier: 'comms', domain: 'lumapps.com',    artistIds: [],          search: ['lumapps'],          bundlePrefixes: ['com.lumapps.'], site: 'https://www.lumapps.com', fcSlug: 'lumapps' },
  { key: 'unily',      name: 'Unily',            tier: 'comms', domain: 'unily.com',      artistIds: [],          search: ['unily'],            bundlePrefixes: ['com.unily.'], altDomains: ['brightstarr.com'], site: 'https://www.unily.com', fcSlug: 'unily' },
  { key: 'interact',   name: 'Interact',         tier: 'comms', domain: 'interactsoftware.com', artistIds: [],    search: ['interact intranet'], bundlePrefixes: ['com.interactsoftware.'], site: 'https://www.interactsoftware.com', fcSlug: 'interact' },
  { key: 'blink',      name: 'Blink',            tier: 'comms', domain: 'joinblink.com',  artistIds: [],          search: ['blink workplace'],  bundlePrefixes: ['com.joinblink.'], site: 'https://joinblink.com', fcSlug: 'blink' },
  { key: 'flip',       name: 'Flip',             tier: 'comms', domain: 'getflip.com',    artistIds: [],          search: ['flip employee app'], bundlePrefixes: ['com.getflip.'], site: 'https://www.getflip.com', fcSlug: 'flip' },
  { key: 'talkspirit', name: 'Talkspirit',       tier: 'comms', domain: 'talkspirit.com', artistIds: [],          search: ['talkspirit'],       bundlePrefixes: ['com.talkspirit.'], site: 'https://www.talkspirit.com', fcSlug: 'talkspirit' },
  { key: 'jostle',     name: 'Jostle',           tier: 'comms', domain: 'jostle.me',      artistIds: [],          search: ['jostle intranet'],  bundlePrefixes: ['com.jostle.'], playDeveloper: 'Jostle Corporation', site: 'https://jostle.me', fcSlug: 'jostle' },
  { key: 'yoobic',     name: 'YOOBIC',           tier: 'comms', domain: 'yoobic.com',     artistIds: [],          search: ['yoobic'],           bundlePrefixes: ['com.yoobic.'], site: 'https://www.yoobic.com', fcSlug: 'yoobic' },
  { key: 'employeeapp', name: 'theEMPLOYEEapp',  tier: 'comms', domain: 'theemployeeapp.com', artistIds: [],      search: ['theemployeeapp'],   bundlePrefixes: ['com.theemployeeapp.'], site: 'https://theemployeeapp.com', fcSlug: 'theemployeeapp' },

  // --- social suites with advocacy add-ons ------------------------------
  { key: 'hootsuite',  name: 'Hootsuite Amplify', tier: 'social', domain: 'hootsuite.com', artistIds: [], search: ['hootsuite amplify'], bundlePrefixes: ['com.hootsuite.amplify'], site: 'https://www.hootsuite.com', fcSlug: 'hootsuite' },
  { key: 'sprinklr',   name: 'Sprinklr',          tier: 'social', domain: 'sprinklr.com',  artistIds: [], search: ['sprinklr'],          bundlePrefixes: ['com.sprinklr.'], playDeveloper: 'Sprinklr', site: 'https://www.sprinklr.com', fcSlug: 'sprinklr' },
  { key: 'bambu',      name: 'Bambu by Sprout Social', tier: 'social', domain: 'sproutsocial.com', artistIds: [], search: ['bambu sprout'], bundlePrefixes: ['com.sproutsocial.bambu'], site: 'https://sproutsocial.com', fcSlug: 'sprout-social' },
  // --- added 2026-08-29 from category roundups (DSMN8, GaggleAMP, Guideflow)
  // and the FeaturedCustomers "Employee Advocacy Software" category listing.
  // These have no white-label mobile apps found, so vendor-site scraping is the
  // only evidence source for them.
  { key: 'sproutsocial',   name: 'Sprout Social Employee Advocacy', tier: 'social',   domain: 'sproutsocial.com',  artistIds: [], bundlePrefixes: ['com.sproutsocial.'], site: 'https://sproutsocial.com', fcSlug: 'sprout-social' },
  { key: 'drumup',         name: 'DrumUp',            tier: 'advocacy', domain: 'drumup.io',          artistIds: [], bundlePrefixes: ['io.drumup.'],        site: 'https://drumup.io',            fcSlug: 'drumup' },
  { key: 'marketbeam',     name: 'MarketBeam',        tier: 'advocacy', domain: 'marketbeam.io',      artistIds: [], bundlePrefixes: ['io.marketbeam.'],    site: 'https://www.marketbeam.io',    fcSlug: 'marketbeam' },
  { key: 'marketscale',    name: 'MarketScale',       tier: 'advocacy', domain: 'marketscale.com',    artistIds: [], bundlePrefixes: ['com.marketscale.'],  site: 'https://marketscale.com',      fcSlug: 'marketscale' },
  { key: 'socialseeder',   name: 'Social Seeder',     tier: 'advocacy', domain: 'socialseeder.com',   artistIds: [], bundlePrefixes: ['com.socialseeder.'], site: 'https://www.socialseeder.com', fcSlug: 'social-seeder' },
  { key: 'influitive',     name: 'Influitive',        tier: 'advocacy', domain: 'influitive.com',     artistIds: [], bundlePrefixes: ['com.influitive.'],   site: 'https://influitive.com',       fcSlug: 'influitive' },
  { key: 'agorapulse',     name: 'Agorapulse',        tier: 'social',   domain: 'agorapulse.com',     artistIds: [], bundlePrefixes: ['com.agorapulse.'],   site: 'https://www.agorapulse.com',   fcSlug: 'agorapulse' },
  { key: 'socialchamp',    name: 'Social Champ',      tier: 'social',   domain: 'socialchamp.io',     artistIds: [], bundlePrefixes: ['io.socialchamp.'],   site: 'https://www.socialchamp.io',   fcSlug: 'social-champ' },
  { key: 'paiger',         name: 'Paiger',            tier: 'advocacy', domain: 'paiger.co',          artistIds: [], bundlePrefixes: ['co.paiger.'],        site: 'https://paiger.co',            fcSlug: 'paiger' },
  { key: 'soampli',        name: 'SoAmpli',           tier: 'advocacy', domain: 'soampli.com',        artistIds: [], bundlePrefixes: ['com.soampli.'],      site: 'https://www.soampli.com',      fcSlug: 'soampli' },
  { key: 'lately',         name: 'Lately',            tier: 'social',   domain: 'lately.ai',          artistIds: [], bundlePrefixes: ['ai.lately.'],        site: 'https://www.lately.ai',        fcSlug: 'lately' },
  { key: 'poppulo',        name: 'Poppulo',           tier: 'comms',    domain: 'poppulo.com',        artistIds: [], bundlePrefixes: ['com.poppulo.'],      site: 'https://www.poppulo.com',      fcSlug: 'poppulo' },
  { key: 'happeo',         name: 'Happeo',            tier: 'comms',    domain: 'happeo.com',         artistIds: [], bundlePrefixes: ['com.happeo.'],       site: 'https://www.happeo.com',       fcSlug: 'happeo' },
  { key: 'powell',         name: 'Powell Software',   tier: 'comms',    domain: 'powell-software.com',artistIds: [], bundlePrefixes: ['com.powellsoftware.'], site: 'https://powell-software.com', fcSlug: 'powell-software' },
  { key: 'akumina',        name: 'Akumina',           tier: 'comms',    domain: 'akumina.com',        artistIds: [], bundlePrefixes: ['com.akumina.'],      site: 'https://akumina.com',          fcSlug: 'akumina' },
  { key: 'igloo',          name: 'Igloo Software',    tier: 'comms',    domain: 'igloosoftware.com',  artistIds: [], bundlePrefixes: ['com.igloosoftware.'],site: 'https://www.igloosoftware.com',fcSlug: 'igloo-software' },
  { key: 'contactmonkey',  name: 'ContactMonkey',     tier: 'comms',    domain: 'contactmonkey.com',  artistIds: [], bundlePrefixes: ['com.contactmonkey.'],site: 'https://www.contactmonkey.com',fcSlug: 'contactmonkey' },
  { key: 'cerkl',          name: 'Cerkl Broadcast',   tier: 'comms',    domain: 'cerkl.com',          artistIds: [], bundlePrefixes: ['com.cerkl.'],        site: 'https://cerkl.com',            fcSlug: 'cerkl' },
  { key: 'snapcomms',      name: 'SnapComms',         tier: 'comms',    domain: 'snapcomms.com',      artistIds: [], bundlePrefixes: ['com.snapcomms.'],    site: 'https://www.snapcomms.com',    fcSlug: 'snapcomms' },
  { key: 'workshop',       name: 'Workshop',          tier: 'comms',    domain: 'useworkshop.com',    artistIds: [], bundlePrefixes: ['com.useworkshop.'],  site: 'https://www.useworkshop.com',  fcSlug: 'workshop' },
  { key: 'axioshq',        name: 'Axios HQ',          tier: 'comms',    domain: 'axioshq.com',        artistIds: [], bundlePrefixes: ['com.axioshq.'],      site: 'https://www.axioshq.com',      fcSlug: 'axios-hq' },
];

export const VENDOR_BY_KEY = Object.fromEntries(VENDORS.map((v) => [v.key, v]));
