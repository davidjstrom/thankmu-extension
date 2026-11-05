/*******************************************************************************

    ThankMu extension pages (popup frame, account page): the dark variant.
    tokens.css defines dark only as .theme-dark, which "a panel or page" opts
    into. These pages opt in when the system is dark, and follow it live.
    Nothing here defines a colour.

******************************************************************************/

export function followSystemTheme(win = window) {
    const mq = win.matchMedia?.('(prefers-color-scheme: dark)');
    if ( !mq ) { return; }
    const apply = ( ) => { win.document.documentElement.classList.toggle('theme-dark', mq.matches); };
    apply();
    mq.addEventListener?.('change', apply);
}
