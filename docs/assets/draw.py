# Legacy generator — superseded by the claude.ai/design "Redesign visual"
# project (Orch Mark.dc.html / export-avatar.dc.html). docs/assets/orch-avatar.png
# and orch-avatar-1024.png are exported from that design source now, not from
# this script; it's kept for history but its output names/pipeline (avatar.png,
# avatar@1024.png, logo.png) no longer match the committed asset names.
import cairo, math

def hx(h):
    h=h.lstrip('#'); return tuple(int(h[i:i+2],16)/255 for i in (0,2,4))

BG1,BG2 = hx('1a1a1a'), hx('0a0a0a')
R1,R2,R3 = hx('f97316'), hx('fb923c'), hx('fbbf24')
CHK = hx('f5f5f5'); BRK = hx('a3a3a3')

def rounded_rect(c,x,y,w,h,r):
    c.new_sub_path()
    c.arc(x+w-r,y+r,r,-math.pi/2,0)
    c.arc(x+w-r,y+h-r,r,0,math.pi/2)
    c.arc(x+r,y+h-r,r,math.pi/2,math.pi)
    c.arc(x+r,y+r,r,math.pi,1.5*math.pi)
    c.close_path()

def ring_grad(x0,y0,x1,y1):
    g=cairo.LinearGradient(x0,y0,x1,y1)
    g.add_color_stop_rgb(0,*R1); g.add_color_stop_rgb(.55,*R2); g.add_color_stop_rgb(1,*R3)
    return g

def draw_mark(c,cx,cy,s):
    # s = scale where ring radius = 138 at s=1, centered at (cx,cy)
    def P(v): return v*s
    # ring
    c.set_line_cap(cairo.LINE_CAP_ROUND)
    c.set_source(ring_grad(cx-P(138),cy-P(138),cx+P(138),cy+P(138)))
    c.set_line_width(P(34)); c.arc(cx,cy,P(138),0,2*math.pi); c.stroke()
    # agent nodes (top=author, bottom=auditor)
    for dy in (-138,138):
        c.arc(cx,cy+P(dy),P(26),0,2*math.pi)
        c.set_source_rgb(*BG2); c.fill_preserve()
        c.set_source(ring_grad(cx-P(138),cy-P(138),cx+P(138),cy+P(138)))
        c.set_line_width(P(14)); c.stroke()
    # merge checkmark
    c.set_source_rgb(*CHK); c.set_line_width(P(30))
    c.set_line_join(cairo.LINE_JOIN_ROUND)
    c.move_to(cx+P(-58),cy+P(6)); c.line_to(cx+P(-18),cy+P(48)); c.line_to(cx+P(60),cy+P(-44)); c.stroke()
    # CLI brackets
    c.set_source_rgb(*BRK); c.set_line_width(P(16))
    bx,by,bh=P(106),P(106),P(212)
    c.move_to(cx-bx+P(26),cy-by); c.line_to(cx-bx,cy-by); c.line_to(cx-bx,cy-by+bh); c.line_to(cx-bx+P(26),cy-by+bh); c.stroke()
    c.move_to(cx+bx-P(26),cy-by); c.line_to(cx+bx,cy-by); c.line_to(cx+bx,cy-by+bh); c.line_to(cx+bx-P(26),cy-by+bh); c.stroke()

def draw_mark2(c,cx,cy,s,brackets=False):
    # cyclic ring, 4 stage-dots, clockwise arrows; optional [ ] frame
    P=lambda v:v*s
    g=ring_grad(cx-P(138),cy-P(138),cx+P(138),cy+P(138))
    c.set_line_cap(cairo.LINE_CAP_ROUND)
    c.set_source(g); c.set_line_width(P(30)); c.arc(cx,cy,P(138),0,2*math.pi); c.stroke()
    # 4 stage dots: author / audit / gate / merge (dark halo separates from ring)
    for deg in (-90,0,90,180):
        a=math.radians(deg)
        dx,dy=cx+P(138)*math.cos(a),cy+P(138)*math.sin(a)
        c.set_source_rgb(*BG2); c.arc(dx,dy,P(22)+P(8),0,2*math.pi); c.fill()
        c.set_source(g); c.arc(dx,dy,P(22),0,2*math.pi); c.fill()
    # clockwise arrowheads on the ring -> repetition (dark halo separates from ring)
    def arrow(px,py,tx,ty,nx,ny):
        hl,hw=P(34),P(30)
        c.move_to(px+tx*hl,py+ty*hl)
        c.line_to(px-tx*hl+nx*hw,py-ty*hl+ny*hw)
        c.line_to(px-tx*hl-nx*hw,py-ty*hl-ny*hw)
        c.close_path()
    for deg in (-45,135):
        a=math.radians(deg)
        px,py=cx+P(138)*math.cos(a),cy+P(138)*math.sin(a)
        tx,ty=-math.sin(a),math.cos(a)   # clockwise tangent (screen y down)
        nx,ny=math.cos(a),math.sin(a)    # outward radial
        c.set_source_rgb(*BG2); c.set_line_join(cairo.LINE_JOIN_ROUND); c.set_line_width(P(16))
        arrow(px,py,tx,ty,nx,ny); c.stroke()
        c.set_source(g); arrow(px,py,tx,ty,nx,ny); c.fill()
    # optional [ ] frame
    if brackets:
        c.set_source_rgb(*BRK); c.set_line_width(P(16))
        c.set_line_cap(cairo.LINE_CAP_BUTT); c.set_line_join(cairo.LINE_JOIN_MITER)
        bx,by,bh,ear=P(100),P(94),P(188),P(26)
        c.move_to(cx-bx+ear,cy-by); c.line_to(cx-bx,cy-by); c.line_to(cx-bx,cy-by+bh); c.line_to(cx-bx+ear,cy-by+bh); c.stroke()
        c.move_to(cx+bx-ear,cy-by); c.line_to(cx+bx,cy-by); c.line_to(cx+bx,cy-by+bh); c.line_to(cx+bx-ear,cy-by+bh); c.stroke()
    # center checkmark
    c.set_source_rgb(*CHK); c.set_line_width(P(30)); c.set_line_join(cairo.LINE_JOIN_ROUND)
    c.set_line_cap(cairo.LINE_CAP_ROUND)
    c.move_to(cx+P(-58),cy+P(6)); c.line_to(cx+P(-18),cy+P(48)); c.line_to(cx+P(60),cy+P(-44)); c.stroke()

def avatar(size, path):
    surf=cairo.ImageSurface(cairo.FORMAT_ARGB32,size,size)
    c=cairo.Context(surf); k=size/512
    g=cairo.LinearGradient(0,0,size,size); g.add_color_stop_rgb(0,*BG1); g.add_color_stop_rgb(1,*BG2)
    rounded_rect(c,0,0,size,size,112*k); c.set_source(g); c.fill()
    rounded_rect(c,8*k,8*k,size-16*k,size-16*k,104*k)
    c.set_source_rgba(1,1,1,.06); c.set_line_width(2*k); c.stroke()
    draw_mark2(c,size/2,size/2,1.2*k,brackets=True)
    surf.write_to_png(path); print("wrote",path)

def logo(path):
    W,H=1240,360
    surf=cairo.ImageSurface(cairo.FORMAT_ARGB32,W,H)
    c=cairo.Context(surf)
    g=cairo.LinearGradient(0,0,W,H); g.add_color_stop_rgb(0,*BG1); g.add_color_stop_rgb(1,*BG2)
    rounded_rect(c,0,0,W,H,64); c.set_source(g); c.fill()
    draw_mark2(c,200,180,120/138)  # ring radius ~120, fits within 360 height
    tx=400
    # "orch" wordmark, orange gradient
    c.select_font_face("monospace",cairo.FONT_SLANT_NORMAL,cairo.FONT_WEIGHT_BOLD)
    c.set_font_size(150)
    c.set_source(ring_grad(tx,90,tx+470,210))
    c.move_to(tx,180); c.show_text("orch")
    # tagline, muted, tracked
    c.select_font_face("monospace",cairo.FONT_SLANT_NORMAL,cairo.FONT_WEIGHT_NORMAL)
    c.set_font_size(40)
    c.set_source_rgb(*hx('d8d2c8'))   # warm light grey, less cold-grey
    tag="agents orchestration tool"; gx=tx+6; gy=258
    for ch in tag:
        c.move_to(gx,gy); c.show_text(ch)
        gx+=c.text_extents(ch).x_advance+6
    surf.write_to_png(path); print("wrote",path)

avatar(512,"avatar.png")
avatar(1024,"avatar@1024.png")
logo("logo.png")
