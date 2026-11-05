/*******************************************************************************

    ThankMu service worker entry (W-P3 part B). The patch step points the
    manifest's background.service_worker here instead of upstream's
    /js/background.js, so no upstream file is edited.

    Import order matters: the ThankMu module registers its listeners
    (onMessageExternal above all) during the first synchronous evaluation,
    before upstream's module runs. A pairing message is often what wakes the
    worker, and a listener added later would miss it.

******************************************************************************/

import './thankmu/sw.js';
import './background.js';
