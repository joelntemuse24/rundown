import { render } from 'preact';
import './global.css';
import { readBoot } from './data';
import { Home } from './Home';
import { Viewer } from './Viewer';

const boot = readBoot();
const app = document.getElementById('app')!;
const match = /^\/r\/([0-9a-f]{12})\/?$/.exec(location.pathname);

if (boot?.mode === 'export') {
  render(<Viewer initial={boot.doc} defaultDepth={boot.depth} exported />, app);
} else if (match) {
  render(<Viewer id={match[1]} defaultDepth={boot?.mode === 'server' ? boot.depth : 'median'} />, app);
} else {
  render(<Home replays={boot?.mode === 'home' ? boot.replays : []} origin={boot?.mode === 'home' ? boot.origin : location.origin} />, app);
}
