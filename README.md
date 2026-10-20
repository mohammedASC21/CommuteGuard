# CommuteGuard

> Proactive Multi-Modal Transit Alert System  
>   
> **Author:** Mohammed Chowdhury · **Course:** CMP 464/343 Product 1 · **Last updated:** 10/04

---

## 1\. About Me (the User)

*Who am I in the context of this problem? What roles am I playing (student, employee, parent, athlete, gamer…)?*

I am a daily NYC college student commuting from home to Lehman College. In this problem, I am playing the role of a daily NYC commuter who relies every morning on a combination of MTA buses, subways, and walking to get to campus on time. Also a role of a student whose time is tied to fixed class times, exams, and lectures, and whose money cannot be wasted on unexpected \$30 Uber rides when transit breaks down. 

**The last 3 times this happened:** *Real, recent moments. For each: when and where, what went wrong, what it cost, and what you did.*

1\. It happened last Thursday when I was commuting to college. I was waiting for the Bx10, and it showed it was 4 minutes away on the transit app, but it came 10 minutes later. I lost around 30 minutes waiting, deciding between taking the D or 4 train and getting to the college after deciding to take the D train.

2\. It happened 2 weeks ago when I was going to college for a Spanish quiz. But the bus was 19 minutes away when I left home, and I realized I would be late and decided to take an Uber instead, which cost me \$22. 

3\. Last month, I walked to the 4 train station instead of taking the unreliable bus. When I arrived, I found out service at that station was temporarily suspended for track work, which I didn’t know about. I ended up having to walk back and wait even longer for a bus anyway, wasting time, burning through my energy, and completely destroying my peace of mind for the morning.

**What it costs me:** *Be specific. How often, how much?*

- ⏱️ Time: About 2 to 3 times a week, transit delays cost me 20 to 30 minutes per incident.   
    
- 💸 Money: When a delay happens and I have an important class or an exam, I am forced to take an emergency Uber. That costs me \$20 to \$25 per ride.  
    
- 🔋 Energy: Overwaiting, switching to a different bus or train,, and walking extra create a constant mental drain.  
    
- 🙂 Joy: I lose my morning peace of mind.

---

## 2\. Problem Statement

**Gut check:**

> I need a way to know about transit delays before I leave my apartment because finding out about ghost buses or suspended train service after I'm already at the station wastes my time, forces me into expensive Ubers, and makes me late for class.

**Five Whys:**

1. Why?  
   Why do I have to to take out an extra time of 20 minutes for my daily commute to Lehman College?  
     
2. Why?  
   Why do I have to wait an extra 5+ minutes on average for a bus when it says it's coming now?

3. Why?  
   Why do I have to take Uber when my delay is long and I don’t have enough time to switch to different routes?

4. Why?  
   Why can’t I get specific warnings for these delays before I leave so I can better plan it?

5. Why?  
   Why do I have to miss important sections of the class due to transit delays?

**Problem statement:**

> **When** I commute to Lehman College on mornings for lectures or exams (3–4 days a week), **I struggle to** get to class on time due to unexpected MTA bus ghosting and subway service suspensions, **which cost me** about 20 to 30 minutes per incident, \$20 to \$25 per ride when I am forced to take an emergency Uber for an exam, create mental drain, and disrupt peace of mind. **This happens because** live transit disruptions are only revealed once I'm already at the stop or down on the platform, where switching to a backup route is slow, time-consuming, and sometimes costs money. **Right now I** manually open transit apps after leaving home to check the wait time, **but** the wait times are not always accurate due to ghost buses, transit delays, or service work, and it’s hard to figure out when it will be delayed and when it will be on time and what decision to make. It also fails to warn me in time to walk to an alternative line.

**I'll know this is solved when I** haven't needed to take a panic rideshare to campus for at least two months, and I never spend more than 5 minutes waiting on a platform for a delayed train or ghost bus.

*Check: none of these words appear: app, website, platform, dashboard, tool, AI, track, automate, notify, feature.*

---

## 

## 

## 3\. Existing Solutions

| What I use or tried | What it does well | Why it falls short *for me* |
| :---- | :---- | :---- |
| Google Maps | Great for step-by-step directions, live map views, and finding new places. | I always have to search for the same route every time I commute, and it's not personalized for me in a way that it can recommend a different route that works best for me when there are transit delays. It doesn’t have a feature to notify me about a delay. |
| MTA Service Alerts (website or app) | Official source for track work and major system-wide delays | Sends generic blasts like "4 trains experiencing delays." It doesn't tell me if my specific bus transfer will be affected. It specifically considers the ghost buses or highly delayed buses. |
| Transit App | Excellent real-time bus tracking and "GO" trip navigation. | It doesn’t have a feature to recommend a different route when there is a delay, and it doesn’t tell me that a bus is a ghost bus; rather, it shows a random time.  |

**The gap:** *In one sentence, what's still missing for me?*

A tool that knows my specific route and my daily commute schedule, then detects ghost buses and station-level disruptions 15 minutes before I leave my apartment, and gives me budget-conscious alternative routes before I waste longer time waiting at a bus stop or switching between buses or trains.

---

## 4\. Features & Benefits

*Every feature should move me toward my "solved when" line.*

| Feature (what it does) | Benefit (how my life gets better) | MVP or Later? |
| :---- | :---- | :---- |
| **Scheduled Morning Commute Alert**  Automatically checks my normal commute about 15 minutes before my usual departure time and sends me a simple status such as “Bx10 looks reliable” or “⚠️ Bx10 unverified—consider walking to the D train.” | I do not have to remember to open multiple transit apps while I am getting ready for college. The information reaches me before I leave home, when I still have time to change my route. | **MVP** |
| **Real-Time Bus Reliability Check**  Uses live MTA transit data to check whether the Bx10 serving my commute appears to be actively progressing toward my stop. Instead of trusting a single arrival estimate, it looks for recent vehicle updates and continued movement. | I have better evidence that my bus is actually coming before I walk outside. This reduces the chance that I spend 10–15 minutes waiting for a bus that appeared to be arriving but was actually delayed or unreliable. | **MVP** |
| **Unverified Warning \+ Backup Route** If the product cannot confidently verify the normal bus because the live information is missing, stale, or conflicting, it clearly displays Unverified / High Ghost Risk and shows my preselected backup route, such as walking to the D train. | I do not have to guess whether I should keep waiting. I immediately have an alternative action I can take while I am still at home, reducing uncertainty, stress, wasted time, and the chance that I panic and order an Uber. | **MVP** |
| **Dynamic Alternate Route Comparison** Compares multiple backup routes in real time and shows which option is best based on current transit conditions. | Helps me choose the best available route instead of always relying on one fixed backup. | **Later** |

## 

| Transfer Station Health Check Checks the status of the subway station or line I would transfer to before recommending that route. | Reduces the chance of leaving one delayed route only to run into another disruption. | Later |
| :---- | :---- | :---- |
| **Commute History & Outcomes** Saves information about which route I took, how long the trip took, and whether the recommendation helped. | Lets me see whether the product is actually reducing delays, stress, and unnecessary Uber rides over time. | **Later** |
| **Service Change Awareness and Escalating Alerts** Checks for planned construction, station closures, reroutes, or scheduled service changes before my commute. | Helps me avoid known disruptions before I leave home. Sends another warning if transit conditions get worse after the first morning check. | **Later** |
| **Multiple Commute Profiles** Lets me save different routes and schedules for different days or destinations. | Makes the product useful when my class schedule or commute changes throughout the week. | **Later** |

## 

## **MVP (2–3 features):** *The skateboard: the smallest version I'd actually use.*

1. **Scheduled Morning Commute Alert**

About 15 minutes before my normal departure time, the product checks my commute and sends me a simple status update so I do not have to remember to manually open the app.

2. **Real-Time Bus Reliability Check**

The product checks recent MTA vehicle data to determine whether my Bx10 appears to be actively progressing toward my stop instead of relying only on a scheduled arrival time.

3. **Unverified Warning \+ Backup Route**

If the bus cannot be confidently verified because the data is stale, missing, or conflicting, the product clearly warns me and shows my preselected backup route, such as walking to the D train.

## **Later:**

Dynamic Alternate Route Comparison: Compare multiple backup routes in real time instead of always using one fixed alternative.

Transfer Station Health Check: Check whether the subway line or station I would transfer to is also experiencing delays or service changes.

Commute History & Outcomes: Save previous route decisions, travel times, and outcomes so I can measure whether the product is actually helping.

Service Change Awareness: Check planned track work, station closures, and scheduled reroutes before my commute.

Multiple Commute Profiles: Allow me to save different routes and departure schedules for different days or destinations.

## **Not doing:** *Things I'm deliberately leaving out.*

Full NYC transit navigation: I am not trying to replace Google Maps, Transit, or the MTA app.

Support for every subway and bus route: The first version is designed around my personal commute to Lehman College.

User accounts or multiple users: This product is being built for myself, so account management is unnecessary for the MVP.

AI chatbot or AI-generated commute advice: My main problem can be handled with clear transit data and simple reliability rules.

Full interactive transit map: I need a quick commute decision, not a detailed map interface.

Native iOS or Android app: I can begin with a mobile-friendly web experience and consider a native app later.

---

## 5\. Tech Stack

### Front end

- **Surface:** \[CLI / Web / Mobile / Cross-platform / Chat\]  
- **Tools:** \[e.g., Next.js, Python, Expo\]  
- **Why:** *How does this fit where and when I have the problem?*

### Back end

| Piece | Choice | Why |
| :---- | :---- | :---- |
| Server / API | Next.js Route Handlers / Server Actions | Keeps my frontend and backend in one project. The backend can request MTA data, run my reliability rules, and return the commute status to the interface. |
| Data storage | Small database such as Supabase/PostgreSQL | Stores my commute settings, departure time, primary route/stop, backup route, and the push-notification subscription needed to send alerts to my phone. |
| Outside services  | MTA GTFS-Realtime | Provides the live transit information needed to check vehicle positions, trips, and service conditions. |
| Hosting / deploy | Vercel | Hosts the Next.js application and can also run scheduled server functions, keeping deployment in one place. |

### 

### Architecture sketch

![][image1]

---

## 6\. Open Questions

*What am I still unsure about? What do I need to figure out or test first?*

1. *How reliable is the MTA GTFS-Realtime data for detecting a possible ghost bus?*  
2. *What should count as “stale” or unreliable vehicle data?*  
3. *Can I correctly identify the specific bus that is supposed to serve my stop?*  
4. *Will scheduled push notifications work reliably on my phone?*  
5. *What should happen if MTA real-time data is completely unavailable?*

[image1]: <data:image/png;base64,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>