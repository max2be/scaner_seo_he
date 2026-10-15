import React from 'react';import{createRoot}from'react-dom/client';
function App(){return <main><h1>Headless SEO Inspector</h1><p>Foundation only. The authenticated web panel will be implemented in EPIC-07/08.</p></main>;}
const target=document.getElementById('root');if(target)createRoot(target).render(<React.StrictMode><App/></React.StrictMode>);
